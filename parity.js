// Parity checks between a project's ci-local plan and its GitHub workflow.
//
// The plan comes from `ci-local --print-plan` (JSON), never from reading the
// bash config with regular expressions; the workflow from its YAML. Each check
// returns a list of problems, empty when the two agree, so a project's test is
// one assertion per check: `assert.deepEqual(problems, [])`.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parse } from 'yaml'

const run = promisify(execFile)
const BIN = fileURLToPath(new URL('./bin/ci-local', import.meta.url))

/** The project's plan, as `ci-local --print-plan` prints it. */
export async function loadPlan({ cwd = process.cwd(), env } = {}) {
  const { stdout } = await run('bash', [BIN, '--print-plan'], {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 16 * 1024 * 1024,
  })
  return JSON.parse(stdout)
}

/** The workflow the plan mirrors (the plan's `workflow`, unless `path` is given). */
export async function loadWorkflow({ cwd = process.cwd(), path, plan } = {}) {
  const file = path ?? plan?.workflow ?? '.github/workflows/ci.yml'
  return parse(await readFile(join(cwd, file), 'utf8'))
}

/** Lines without comments, `\` continuations joined, blanks squeezed. */
export function logicalLines(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .replace(/\\\n\s*/g, '')
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line !== '')
}

const normalize = (source) => logicalLines(source).join('\n')

const label = (step) => step.name ?? logicalLines(step.run ?? step.uses ?? '')[0] ?? '(unnamed step)'

/** A plan step's environment, KEY=VALUE lines as an object. */
export function stepEnv(step) {
  return Object.fromEntries(
    step.env.map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)])
  )
}

/**
 * Every `run:` step of every workflow job is a box step of the plan, with the
 * same commands, or is named with `ci_not_mirrored`; within a job the plan
 * runs them in the workflow's order; and every name given to ci_not_mirrored
 * is a step of the workflow.
 *
 * Each workflow job is a ci-local job (one of CI_JOBS) of the same name, or
 * the one `jobs` maps it to (`{ 'workflow-job': 'ci-job' }`), and its steps
 * are matched only by plan steps that run for that job: those without
 * `--job`, or whose `--job` names it. So `--only JOB` runs what the workflow's
 * job runs. A job with nothing to mirror (only `uses:` steps, or every `run:`
 * named with ci_not_mirrored) needs no ci-local job.
 *
 * A box step declared with `--deviates REASON` stands for the workflow step
 * whose name (or, unnamed, first command line) equals the step's name: it is
 * accepted in that position whatever its command, and REASON is in the plan.
 *
 * `substitutions` are [from, to] pairs applied to the workflow's commands
 * first, for the differences the project makes on purpose (a container name).
 */
export function mirroringProblems(plan, workflow, { substitutions = [], jobs = {} } = {}) {
  const problems = []
  const skipped = new Set(plan.notMirrored.map((entry) => entry.name))
  const box = plan.steps.map((step) => (step.kind === 'box' ? normalize(step.command) : null))
  // Steps that stand for a workflow step under its name, with another command.
  const deviating = plan.steps.map((step) => (step.kind === 'box' && step.deviates ? step.name : null))
  const deviationsUsed = new Set()
  const ciJobs = new Set(plan.jobs ?? [])
  const workflowJobs = Object.entries(workflow.jobs ?? {})
  const names = new Set(
    workflowJobs.flatMap(([, job]) => (job.steps ?? []).map((step) => step.name).filter(Boolean))
  )

  for (const [jobName, job] of workflowJobs) {
    const toMirror = (job.steps ?? []).filter((step) => step.run !== undefined && !skipped.has(step.name))
    if (toMirror.length === 0) continue
    const ciJob = jobs[jobName] ?? jobName
    if (!ciJobs.has(ciJob)) {
      problems.push(`workflow job "${jobName}" is no ci-local job: add it to CI_JOBS, or map it with the jobs option`)
      continue
    }
    const runsFor = (index) => !plan.steps[index].jobs?.length || plan.steps[index].jobs.includes(ciJob)
    let last = -1
    for (const step of toMirror) {
      let command = step.run
      for (const [from, to] of substitutions) command = command.split(from).join(to)
      const wanted = normalize(command)
      const stepLabel = label(step)
      const isExact = (candidate, index) => candidate === wanted && runsFor(index)
      const isDeclared = (candidate, index) => candidate === stepLabel && runsFor(index)
      const exact = box.findIndex((candidate, index) => index > last && isExact(candidate, index))
      const declared = deviating.findIndex((candidate, index) => index > last && isDeclared(candidate, index))
      const after = exact !== -1 ? exact : declared
      if (exact === -1 && declared !== -1) deviationsUsed.add(declared)
      if (after !== -1) {
        last = after
      } else if (box.some(isExact) || deviating.some(isDeclared)) {
        problems.push(`${jobName}: "${stepLabel}" runs out of the workflow's order`)
      } else if (box.includes(wanted) || deviating.includes(stepLabel)) {
        const others = new Set(
          plan.steps.flatMap((planStep, index) =>
            box[index] === wanted || deviating[index] === stepLabel ? planStep.jobs : []
          )
        )
        problems.push(`${jobName}: "${stepLabel}" is in the plan only for other jobs (${[...others].join(', ')})`)
      } else {
        problems.push(`${jobName}: "${stepLabel}" is not in the plan (nor named with ci_not_mirrored)`)
      }
    }
  }
  deviating.forEach((name, index) => {
    if (name !== null && !deviationsUsed.has(index)) {
      problems.push(`"${name}" is declared --deviates, but no workflow step it stands for was found by that name`)
    }
  })
  for (const name of skipped) {
    if (!names.has(name)) problems.push(`ci_not_mirrored names "${name}", which is no step of the workflow`)
  }
  for (const name of Object.keys(jobs)) {
    if (!(workflow.jobs ?? {})[name]) problems.push(`the jobs option maps "${name}", which is no job of the workflow`)
  }
  return problems
}

// ------------------------------------------------------- published ports

const unquote = (token) => token.replace(/^(['"])(.*)\1$/, '$2')
const tokens = (text) => text.trim().split(/\s+/).filter(Boolean).map(unquote)
// The end of one command on a line: `;`, `&&`, `||`, a pipe, `)` or `}`.
const commandText = (rest) => rest.split(/[;&|)}]/)[0]

// `docker run` short flags that take no value. Any other letter takes the
// rest of its cluster, or the next word, as its value.
const BOOLEAN_SHORT = new Set(['d', 'i', 't', 'q'])
const BOOLEAN_LONG = new Set([
  '--detach', '--rm', '--init', '--interactive', '--tty', '--privileged', '--read-only', '--quiet',
  '--no-healthcheck', '--oom-kill-disable', '--disable-content-trust', '--sig-proxy', '--help',
])

/**
 * What the flags of a `docker run` (up to the image) do to the machine's
 * ports: 'port' when they publish one, 'host' when they join the host's
 * network, null otherwise.
 */
function runExposure(words) {
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (word.startsWith('--')) {
      const eq = word.indexOf('=')
      const flag = eq === -1 ? word : word.slice(0, eq)
      if (flag === '--publish' || flag === '--publish-all') return 'port'
      if (BOOLEAN_LONG.has(flag)) continue
      const value = eq === -1 ? words[++i] : unquote(word.slice(eq + 1))
      if ((flag === '--network' || flag === '--net') && value === 'host') return 'host'
    } else if (/^-[A-Za-z]/.test(word)) {
      const letters = word.slice(1)
      for (let k = 0; k < letters.length; k++) {
        if (letters[k] === 'p' || letters[k] === 'P') return 'port'
        if (BOOLEAN_SHORT.has(letters[k])) continue
        if (k === letters.length - 1) i++ // its value is the next word
        break
      }
    } else {
      return null // the image: what follows is the container's command
    }
  }
  return null
}

/** The source of a host step's function and of every config function it reaches. */
function reachableSources(plan, step) {
  const functions = plan.functions ?? {}
  const seen = new Set([step.command?.split(' ')[0]])
  const sources = [step.source ?? '']
  for (let n = 0; n < sources.length; n++) {
    for (const word of sources[n].match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
      if (Object.hasOwn(functions, word) && !seen.has(word)) {
        seen.add(word)
        sources.push(functions[word])
      }
    }
  }
  return sources
}

const COMPOSE_VALUE_OPTIONS = new Set([
  '-f', '--file', '-p', '--project-name', '--project-directory', '--profile', '--env-file', '--ansi',
  '--parallel', '--progress',
])
const COMPOSE_DEFAULTS = [
  ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'],
  ['compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yaml', 'docker-compose.override.yml'],
]

/** The compose files and subcommand of a `docker compose` command. */
function composeCommand(words) {
  const files = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    const eq = word.indexOf('=')
    const flag = word.startsWith('--') && eq !== -1 ? word.slice(0, eq) : word
    if (COMPOSE_VALUE_OPTIONS.has(flag)) {
      const value = flag === word ? words[++i] : unquote(word.slice(eq + 1))
      if (flag === '-f' || flag === '--file') files.push(value)
    } else if (!word.startsWith('-')) {
      return { files, subcommand: word, rest: words.slice(i + 1) }
    }
  }
  return { files, subcommand: null, rest: [] }
}

/** Problems of the compose files a host step brings up, read from `cwd`. */
function composeProblems(stepName, { files, subcommand, rest }, { cwd, project }) {
  if (!['up', 'create', 'run'].includes(subcommand)) return []
  const problems = []
  if (subcommand === 'run' && rest.some((word) => /^(--service-ports|--publish|-p)(=|$)|^-p\d/.test(word))) {
    problems.push(`host step "${stepName}" publishes a port: docker compose run ${rest.join(' ')}`)
  }
  let paths
  if (files.length > 0) {
    paths = files.map((file) => ({
      shown: file,
      path: file
        .replace(/\$\{REPO\}|\$REPO\b/g, cwd)
        .replace(/\$\{CI_PROJECT\}|\$CI_PROJECT\b/g, project ?? ''),
    }))
  } else {
    paths = COMPOSE_DEFAULTS.map((names) => names.find((name) => existsSync(join(cwd, name)))).filter(Boolean)
    if (paths.length === 0) return [`host step "${stepName}": cannot find the compose file it brings up`]
    paths = paths.map((name) => ({ shown: name, path: name }))
  }
  for (const { shown, path } of paths) {
    const full = isAbsolute(path) ? path : join(cwd, path)
    let compose
    try {
      if (path.includes('$')) throw new Error('unresolved variable')
      compose = parse(readFileSync(full, 'utf8')) ?? {}
    } catch {
      problems.push(`host step "${stepName}": cannot check compose file "${shown}" for published ports`)
      continue
    }
    const name = relative(cwd, full) || full
    for (const [service, definition] of Object.entries(compose.services ?? {})) {
      if (subcommand !== 'run' && Array.isArray(definition?.ports) && definition.ports.length > 0) {
        problems.push(`host step "${stepName}": ${name} publishes ports of service "${service}"`)
      }
      if (definition?.network_mode === 'host') {
        problems.push(`host step "${stepName}": ${name} puts service "${service}" on the host network`)
      }
    }
  }
  return problems
}

/**
 * The plan publishes no port, nor joins the host's network: not the runner
 * (CI_RUNNER_ARGS), not a `docker run`/`docker create` in a host step or in a
 * config function it calls, and not a compose file such a step brings up
 * (`docker compose up`, `create` or `run`), read from `cwd`. A published port
 * could collide with the development stack, or reach it. A compose file that
 * cannot be found or read is a problem, not a pass.
 */
export function publishedPortProblems(plan, { cwd = process.cwd() } = {}) {
  const problems = []
  const runner = runExposure([...tokens(plan.runnerArgs.join(' ')), 'IMAGE'])
  if (runner === 'port') problems.push('CI_RUNNER_ARGS publishes a port')
  if (runner === 'host') problems.push('CI_RUNNER_ARGS puts the runner on the host network')
  for (const step of plan.steps.filter((candidate) => candidate.kind === 'host')) {
    for (const source of reachableSources(plan, step)) {
      for (const line of logicalLines(source)) {
        for (const match of line.matchAll(/\bdocker\s+(?:container\s+)?(?:run|create)\b(.*)/g)) {
          const exposure = runExposure(tokens(commandText(match[1])))
          if (exposure === 'port') problems.push(`host step "${step.name}" publishes a port: ${line}`)
          if (exposure === 'host') problems.push(`host step "${step.name}" puts a container on the host network: ${line}`)
        }
        for (const match of line.matchAll(/\bdocker(?:\s+|-)compose\b(.*)/g)) {
          problems.push(...composeProblems(step.name, composeCommand(tokens(commandText(match[1]))), { cwd, project: plan.project }))
        }
      }
    }
  }
  return [...new Set(problems)]
}

/**
 * `.nvmrc` names an exact version and is the workflow's only source of it:
 * every actions/setup-node step reads `node-version-file: .nvmrc`.
 */
export async function nodeVersionProblems(workflow, { cwd = process.cwd() } = {}) {
  const problems = []
  const nvmrc = (await readFile(join(cwd, '.nvmrc'), 'utf8')).trim()
  if (!/^v?\d+\.\d+\.\d+$/.test(nvmrc)) problems.push(`.nvmrc names no exact version: "${nvmrc}"`)
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (!step.uses?.startsWith('actions/setup-node@')) continue
      if (step.with?.['node-version-file'] !== '.nvmrc') {
        problems.push(`${jobName}: setup-node does not read node-version-file: .nvmrc`)
      }
      if (step.with?.['node-version'] !== undefined) {
        problems.push(`${jobName}: setup-node also sets node-version`)
      }
    }
  }
  return problems
}

/** Every check above, for a project whose plan needs no substitutions beyond these. */
export async function parityProblems({ cwd = process.cwd(), substitutions = [], jobs = {} } = {}) {
  const plan = await loadPlan({ cwd })
  const workflow = await loadWorkflow({ cwd, plan })
  return [
    ...mirroringProblems(plan, workflow, { substitutions, jobs }),
    ...publishedPortProblems(plan, { cwd }),
    ...(await nodeVersionProblems(workflow, { cwd })),
  ]
}
