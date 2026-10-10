// Parity checks between a project's ci-local plan and its GitHub workflow.
//
// The plan comes from `ci-local --print-plan` (JSON), never from reading the
// bash config with regular expressions; the workflow from its YAML. Each check
// returns a list of problems, empty when the two agree, so a project's test is
// one assertion per check: `assert.deepEqual(problems, [])`.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
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
 * `substitutions` are [from, to] pairs applied to the workflow's commands
 * first, for the differences the project makes on purpose (a container name).
 */
export function mirroringProblems(plan, workflow, { substitutions = [] } = {}) {
  const problems = []
  const skipped = new Set(plan.notMirrored.map((entry) => entry.name))
  const box = plan.steps.map((step) => (step.kind === 'box' ? normalize(step.command) : null))
  const names = new Set()

  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    let last = -1
    for (const step of job.steps ?? []) {
      if (step.name) names.add(step.name)
      if (step.run === undefined || skipped.has(step.name)) continue
      let command = step.run
      for (const [from, to] of substitutions) command = command.split(from).join(to)
      const wanted = normalize(command)
      const after = box.findIndex((candidate, index) => index > last && candidate === wanted)
      if (after !== -1) {
        last = after
      } else if (box.includes(wanted)) {
        problems.push(`${jobName}: "${label(step)}" runs out of the workflow's order`)
      } else {
        problems.push(`${jobName}: "${label(step)}" is not in the plan (nor named with ci_not_mirrored)`)
      }
    }
  }
  for (const name of skipped) {
    if (!names.has(name)) problems.push(`ci_not_mirrored names "${name}", which is no step of the workflow`)
  }
  return problems
}

const PUBLISH = /(^|\s)(-p|-P|--publish(-all)?)(=|\s|$)/

/**
 * The plan publishes no port: neither the runner (CI_RUNNER_ARGS) nor a
 * `docker run`/`docker create` in a host step. A published port could collide
 * with the development stack, or reach it.
 */
export function publishedPortProblems(plan) {
  const problems = []
  if (plan.runnerArgs.some((arg) => PUBLISH.test(` ${arg} `))) {
    problems.push('CI_RUNNER_ARGS publishes a port')
  }
  for (const step of plan.steps.filter((candidate) => candidate.kind === 'host')) {
    for (const line of logicalLines(step.source ?? '')) {
      if (/\bdocker\s+(run|create)\b/.test(line) && PUBLISH.test(line)) {
        problems.push(`host step "${step.name}" publishes a port: ${line}`)
      }
    }
  }
  return problems
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
export async function parityProblems({ cwd = process.cwd(), substitutions = [] } = {}) {
  const plan = await loadPlan({ cwd })
  const workflow = await loadWorkflow({ cwd, plan })
  return [
    ...mirroringProblems(plan, workflow, { substitutions }),
    ...publishedPortProblems(plan),
    ...(await nodeVersionProblems(workflow, { cwd })),
  ]
}
