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
import { isAlias, isMap, isScalar, isSeq, parse, parseDocument } from 'yaml'

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

/**
 * The source of a host step's function and of every config function it
 * reaches. In the step's own function, `"$@"`, `$*` and `$1`… are the
 * arguments the step gives it, when the plan records them, none holds a space
 * and the function does not move them (`shift`, `set --`); otherwise, and in
 * the other functions, they stay, and read as unknown. So does a `$N` past the
 * last argument.
 */
function reachableSources(plan, step) {
  const functions = plan.functions ?? {}
  const seen = new Set([step.command?.split(' ')[0]])
  let own = step.source ?? ''
  const args = step.args
  const readable = Array.isArray(args) && args.every((arg) => arg !== '' && !/[\s'"$;&|(){}]/.test(arg))
  if (readable && !/\b(?:shift\b|set\s+--)/.test(own)) {
    own = own
      .replace(/"?\$(?:\{[@*]\}|[@*])"?/g, args.join(' '))
      .replace(/"?\$(?:\{([1-9])\}|([1-9]))"?/g, (match, braced, bare) => args[Number(braced ?? bare) - 1] ?? match)
  }
  const sources = [own]
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
// Options of `up`/`create` and of `run` that take a value. Taking one for a
// flag that has none only drops a service name, which counts every service.
const UP_VALUE_OPTIONS = new Set([
  '--scale', '-t', '--timeout', '--wait-timeout', '--exit-code-from', '--attach', '--no-attach', '--pull',
])
const RUN_VALUE_OPTIONS = new Set([
  '-e', '--env', '--env-from-file', '--name', '-p', '--publish', '-u', '--user', '-w', '--workdir', '-v',
  '--volume', '-l', '--label', '--entrypoint', '--pull', '--cap-add', '--cap-drop',
])

/** The global options and subcommand of a `docker compose` command. */
function composeCommand(words) {
  const command = { files: [], profiles: [], envFiles: [], subcommand: null, rest: [] }
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    const eq = word.indexOf('=')
    const flag = word.startsWith('--') && eq !== -1 ? word.slice(0, eq) : word
    if (COMPOSE_VALUE_OPTIONS.has(flag)) {
      const value = flag === word ? words[++i] : unquote(word.slice(eq + 1))
      if (flag === '-f' || flag === '--file') command.files.push(value)
      if (flag === '--profile') command.profiles.push(value)
      if (flag === '--env-file') command.envFiles.push(value)
    } else if (!word.startsWith('-')) {
      return { ...command, subcommand: word, rest: words.slice(i + 1) }
    }
  }
  return command
}

/** The words of `rest` that are not options or their values, up to `limit`. */
function positionals(rest, valueOptions, limit = Infinity) {
  const found = []
  for (let i = 0; i < rest.length && found.length < limit; i++) {
    const word = rest[i]
    if (word === '--') continue
    if (word.startsWith('-')) {
      if (valueOptions.has(word)) i++
      continue
    }
    found.push(word)
  }
  return found
}

/** The COMPOSE_ variables of a dotenv file, as compose reads them; {} when it cannot be read. */
function composeDotenv(path) {
  const variables = {}
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return variables
  }
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?(COMPOSE_[A-Z_]+)\s*=\s*(.*?)\s*$/)
    if (match) variables[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return variables
}

const keyName = (key) => (isScalar(key) ? key.value : key)
// No value: absent, a `!reset`, or a bare `key:`.
const empty = (node) => node == null || (isScalar(node) && node.value == null)
// An alias stands for the node it names.
const resolved = (document, node) => (isAlias(node) ? node.resolve(document) : node)

const names = (document, node) => {
  if (isSeq(node)) return node.items.map((item) => String(keyName(resolved(document, item))))
  if (isMap(node)) return node.items.map((pair) => String(keyName(pair.key)))
  return []
}

/**
 * The keys of a mapping, name to node, with its YAML merge keys (`<<`)
 * applied: its own keys win, then the earlier of the mappings merged.
 */
function fields(document, node) {
  const found = new Map()
  const map = resolved(document, node)
  if (!isMap(map)) return found
  for (const { key, value } of map.items) {
    if (keyName(key) !== '<<') continue
    const sources = resolved(document, value)
    for (const source of isSeq(sources) ? sources.items : [sources]) {
      for (const [name, field] of fields(document, source)) if (!found.has(name)) found.set(name, field)
    }
  }
  for (const { key, value } of map.items) if (keyName(key) !== '<<') found.set(keyName(key), value)
  return found
}

/**
 * Merges one compose document into `services`, as compose merges files:
 * `ports`, `profiles` and `depends_on` add up, `network_mode` is replaced,
 * and `!reset` (cleared) or `!override` (replaced) on a key or a service
 * stands instead. Aliases and merge keys are followed. Only what the port
 * check needs is kept.
 */
function mergeCompose(services, document, file) {
  for (const [key, given] of fields(document, document.get('services', true))) {
    const name = String(key)
    const definition = resolved(document, given)
    const tag = given?.tag ?? definition?.tag
    if (tag === '!reset') {
      services.delete(name)
      continue
    }
    if (tag === '!override' || !services.has(name)) {
      services.set(name, { ports: [], networkMode: null, profiles: [], dependsOn: [] })
    }
    const service = services.get(name)
    for (const [field, value] of fields(document, definition)) {
      const node = resolved(document, value)
      const fieldTag = value?.tag ?? node?.tag
      const replace = fieldTag === '!reset' || fieldTag === '!override'
      const kept = fieldTag === '!reset' ? null : node
      if (field === 'network_mode') {
        const mode = isScalar(kept) ? kept.value : null
        service.networkMode = mode === null ? null : { mode: String(mode), file }
      } else if (field === 'ports') {
        // Not a list (an alias to one port, a variable): counted, not dropped.
        const ports = isSeq(kept) ? kept.items.map(() => file) : empty(kept) ? [] : [file]
        service.ports = replace ? ports : [...service.ports, ...ports]
      } else if (field === 'profiles' || field === 'depends_on') {
        const key = field === 'profiles' ? 'profiles' : 'dependsOn'
        // Profiles that are not a list read as unknown: the service counts.
        const given = field === 'profiles' && !empty(kept) && !isSeq(kept) ? ['$'] : names(document, kept)
        service[key] = replace ? given : [...service[key], ...given]
      }
    }
  }
}

/**
 * The services a compose command starts: those it names and what they depend
 * on, or, naming none, those of no profile or of an enabled one. A name or a
 * profile that cannot be read (a variable) counts every service.
 */
function startedServices(services, { subcommand, rest }, profiles) {
  const named =
    subcommand === 'run' ? positionals(rest, RUN_VALUE_OPTIONS, 1) : positionals(rest, UP_VALUE_OPTIONS)
  if (named.some((name) => name.includes('$'))) return new Set(services.keys())
  const known = named.filter((name) => services.has(name))
  if (named.length > 0 && known.length === 0) return new Set(services.keys())
  if (known.length === 0) {
    const all = profiles.some((profile) => profile === '*' || profile.includes('$'))
    return new Set(
      [...services]
        .filter(
          ([, service]) =>
            all ||
            service.profiles.length === 0 ||
            service.profiles.some((profile) => profile.includes('$') || profiles.includes(profile))
        )
        .map(([name]) => name)
    )
  }
  const started = new Set(known)
  for (const name of started) {
    for (const dependency of services.get(name)?.dependsOn ?? []) started.add(dependency)
  }
  return started
}

/**
 * Problems of the compose files a host step brings up, read from `cwd`:
 * the `-f` files, else COMPOSE_FILE (from the plan's environment, else the
 * `.env` file), else the default file and its override; merged in order, and
 * only the services the command starts.
 */
function composeProblems(stepName, command, { cwd, project, composeEnv = {} }) {
  const { files, subcommand, rest } = command
  if (!['up', 'create', 'run'].includes(subcommand)) return []
  const problems = []
  if (subcommand === 'run' && rest.some((word) => /^(--service-ports|--publish|-p)(=|$)|^-p\d/.test(word))) {
    problems.push(`host step "${stepName}" publishes a port: docker compose run ${rest.join(' ')}`)
  }
  const resolve = (file) =>
    file.replace(/\$\{REPO\}|\$REPO\b/g, cwd).replace(/\$\{CI_PROJECT\}|\$CI_PROJECT\b/g, project ?? '')
  // The env files compose reads instead of `.env`, later ones winning; an
  // empty COMPOSE_ENV_FILES is unset.
  let envFiles = command.envFiles
  if (envFiles.length === 0) envFiles = (composeEnv.COMPOSE_ENV_FILES ?? '').split(',').filter(Boolean)
  if (envFiles.length === 0) envFiles = ['.env']
  const fromFiles = envFiles.map(resolve).map((path) => composeDotenv(isAbsolute(path) ? path : join(cwd, path)))
  const env = { ...Object.assign({}, ...fromFiles), ...composeEnv }
  let paths
  if (files.length > 0) {
    paths = files.map((file) => ({ shown: file, path: resolve(file) }))
  } else if (env.COMPOSE_FILE) {
    paths = env.COMPOSE_FILE.split(env.COMPOSE_PATH_SEPARATOR || ':')
      .filter(Boolean)
      .map((file) => ({ shown: file, path: resolve(file) }))
  } else {
    paths = COMPOSE_DEFAULTS.map((names) => names.find((name) => existsSync(join(cwd, name)))).filter(Boolean)
    if (paths.length === 0) return [`host step "${stepName}": cannot find the compose file it brings up`]
    paths = paths.map((name) => ({ shown: name, path: name }))
  }
  const services = new Map()
  for (const { shown, path } of paths) {
    const full = isAbsolute(path) ? path : join(cwd, path)
    let document
    try {
      if (path.includes('$')) throw new Error('unresolved variable')
      document = parseDocument(readFileSync(full, 'utf8'))
      if (document.errors.length > 0) throw document.errors[0]
    } catch {
      problems.push(`host step "${stepName}": cannot check compose file "${shown}" for published ports`)
      continue
    }
    mergeCompose(services, document, relative(cwd, full) || full)
  }
  const profiles = [...command.profiles, ...(env.COMPOSE_PROFILES ?? '').split(',')].filter(Boolean)
  const started = startedServices(services, command, profiles)
  // `run` publishes no port of its own service without --service-ports.
  const target = subcommand === 'run' ? positionals(rest, RUN_VALUE_OPTIONS, 1)[0] : null
  for (const [name, service] of services) {
    if (!started.has(name)) continue
    if (name !== target && service.ports.length > 0) {
      const from = [...new Set(service.ports)].join(' and ')
      problems.push(`host step "${stepName}": ${from} publishes ports of service "${name}"`)
    }
    const network = service.networkMode
    if (network?.mode === 'host') {
      problems.push(`host step "${stepName}": ${network.file} puts service "${name}" on the host network`)
    } else if (network?.mode.includes('$')) {
      problems.push(
        `host step "${stepName}": ${network.file} may put service "${name}" on the host network: network_mode "${network.mode}"`
      )
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
          const command = composeCommand(tokens(commandText(match[1])))
          const context = { cwd, project: plan.project, composeEnv: plan.composeEnv }
          problems.push(...composeProblems(step.name, command, context))
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
