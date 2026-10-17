// ci-local --status: the state of the last run, from its events file, as a
// three-line Markdown block to paste while waiting and when the run ends.
//
//   node status.js EVENTS_FILE
//
// Exit status: 0 passed, 1 failed, 2 no run recorded, 3 running, 4 stopped
// (interrupted, or the process is gone without an end event).

import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** The events of the last run in the file (from its last `run` event). */
export function lastRun(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A line being written, or not ours: skip it.
    }
  }
  const start = events.findLastIndex((event) => event.event === 'run')
  return start === -1 ? null : events.slice(start)
}

/** True when a process with this pid exists (ours or not). */
function alive(pid) {
  if (!Number.isInteger(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

export function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

const quote = (arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`)

/**
 * The state of a run from its events: one of running, passed, failed,
 * stopped, with what the block shows. `isAlive` is injectable for tests.
 */
export function runState(events, { now = Date.now(), isAlive = alive } = {}) {
  const run = events[0]
  const end = events.findLast((event) => event.event === 'end')
  // The step under way, or the last one that failed: a start with no ok after it.
  let step = null
  for (const event of events) {
    if (event.event === 'start' || event.event === 'fail') step = event
    if (event.event === 'ok') step = null
  }
  const fail = events.findLast((event) => event.event === 'fail') ?? null
  let state
  if (end) state = end.result === 'passed' ? 'passed' : end.result === 'interrupted' ? 'stopped' : 'failed'
  else state = isAlive(run.pid) ? 'running' : 'stopped'
  return {
    state,
    project: run.project,
    total: run.total,
    commit: run.commit,
    hasCommit: 'commit' in run,
    command: ['ci-local', ...(run.args ?? []).map(quote)].join(' '),
    logDir: run.logDir ?? null,
    pid: run.pid,
    step,
    fail,
    end: end ?? null,
    devStack: end?.devStack ?? null,
    elapsedMs: end ? end.durationMs : now - Date.parse(run.ts),
  }
}

const stepRef = (step) => `${step.step} (step ${step.index}/${step.total}`

/** The block, and its exit status. */
export function render(state, eventsFile) {
  const where = [`\`${state.command}\``, `project \`${state.project}\``]
  if (state.hasCommit) where.push(state.commit ? `\`${state.commit}\`` : 'not a git checkout')
  const time = duration(state.elapsedMs)
  const log = (step) => (step?.log ? ` · log: \`${step.log}\`` : '')

  if (state.state === 'running') {
    const now = state.step ? ` · [${state.step.index}/${state.step.total}] ${state.step.step}` : ''
    const follow = [`Follow it: \`tail -f ${eventsFile}\``]
    if (state.logDir) follow.push(`step output: \`${state.logDir}\``)
    return {
      code: 3,
      lines: [`> 🐳 **ci-local** · running${now}`, `> ${[...where, `${time} so far`].join(' · ')}`, `> ${follow.join(' · ')}`],
    }
  }
  if (state.state === 'passed') {
    const steps = `${state.total} step${state.total === 1 ? '' : 's'}`
    const dev = state.devStack === 'untouched' ? ' · Development stack untouched' : ''
    return {
      code: 0,
      lines: ['> ✅ **ci-local** · passed', `> ${where.join(' · ')}`, `> ${steps} · ${time} · every step passed${dev}.`],
    }
  }
  if (state.state === 'failed') {
    let why
    if (state.fail) {
      const exit = state.fail.exitCode === 124 || state.fail.exitCode === 137 ? 'timed out' : `exit ${state.fail.exitCode}`
      why = `Failed at: ${stepRef(state.fail)}, ${exit}) · ${time}${log(state.fail)}`
    } else if (state.devStack === 'changed') {
      why = `The development stack changed during the run · ${time}`
    } else {
      why = `Failed · ${time}`
    }
    return { code: 1, lines: ['> ❌ **ci-local** · failed', `> ${where.join(' · ')}`, `> ${why}.`] }
  }
  // stopped
  let why
  if (state.end) {
    why = `Interrupted${state.step ? ` during: ${stepRef(state.step)})` : ''} · ${time}${log(state.step)}`
  } else {
    why = `No end: process ${state.pid} is gone (killed, or Docker froze)${
      state.step ? ` · during: ${stepRef(state.step)})` : ''
    }${log(state.step)}`
  }
  return { code: 4, lines: ['> ⚠️ **ci-local** · stopped', `> ${where.join(' · ')}`, `> ${why}.`] }
}

function main(file) {
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    // No file: no run recorded.
  }
  const events = lastRun(text)
  if (!events) {
    process.stderr.write(`ci-local: no run recorded in ${file}\n`)
    return 2
  }
  const { code, lines } = render(runState(events), file)
  process.stdout.write(lines.join('\n') + '\n')
  return code
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv[2])
}
