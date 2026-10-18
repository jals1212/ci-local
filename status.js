// ci-local --status: the state of the last run, from its events file, as a
// three-line Markdown block to paste while waiting and when the run ends.
//
//   node status.js EVENTS_FILE
//
// Exit status: 0 passed, 1 failed, 2 no run recorded, 3 queued, starting or
// running, 4 stopped (interrupted, or the process is gone without an end
// event, or before its turn came).

import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/**
 * The events of the last run in the file: from its `queued` events (the
 * first of the last series, which a run repeats while its place changes),
 * or, in a file from before the queue, from its last `run`.
 */
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
  const lastQueued = events.findLastIndex((event) => event.event === 'queued')
  if (lastQueued === -1) {
    const lastRunEvent = events.findLastIndex((event) => event.event === 'run')
    return lastRunEvent === -1 ? null : events.slice(lastRunEvent)
  }
  return events.slice(firstOfQueuedSeries(events, lastQueued))
}

/**
 * The index of the first `queued` event of the unbroken series that ends at
 * `index`: a waiting run repeats the event, with its own pid, each time its
 * place changes.
 */
function firstOfQueuedSeries(events, index) {
  const { pid } = events[index]
  let first = index
  while (first > 0 && events[first - 1].event === 'queued' && events[first - 1].pid === pid) first--
  return first
}

/** How far apart two readings of one process's start time may be, in seconds (see `bin/ci-local`). */
export const PID_START_TOLERANCE = 3

/** How long a start time read from ps is kept, in milliseconds: one tick of the Pi extension asks every second. */
const PID_START_LIFETIME = 5000

/** A pid that can be a run: 0 is the process group for `kill`, and 1 is init. */
const isRunPid = (pid) => Number.isInteger(pid) && pid > 1

/**
 * A reader of the start time of a process, as `bin/ci-local` records it next
 * to the pid (its `pid_start`, which must give the same string): `ps -o
 * lstart=` reads on macOS and on Linux alike, where /proc exists only on
 * Linux. Its text depends on the locale and the time zone, so both are fixed
 * here, and whitespace is squeezed (a one-digit day is padded). Null when the
 * process is gone or ps cannot say. A start time is kept for `ttl`
 * milliseconds, so a status line asked every second does not spawn ps every
 * second; a null is never kept, so a ps that failed once is asked again.
 * `spawn` and `now` are for tests.
 */
export function createPidStartReader({ spawn = spawnSync, now = Date.now, ttl = PID_START_LIFETIME } = {}) {
  const kept = new Map() // pid -> { start, at }
  return (pid) => {
    if (!isRunPid(pid)) return null
    const hit = kept.get(pid)
    if (hit && now() - hit.at < ttl) return hit.start
    kept.delete(pid)
    const out = spawn('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    })
    const start = out.error || out.status !== 0 ? '' : out.stdout.trim().replace(/\s+/g, ' ')
    if (!start) return null
    kept.set(pid, { start, at: now() })
    return start
  }
}

/** The start time of a process (see `createPidStartReader`). */
export const pidStart = createPidStartReader()

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Milliseconds since the epoch of a start time text (UTC, as `pidStart` gives it); null when it is not one. */
function instantOf(text) {
  const match = /^\w{3} (\w{3}) +(\d+) (\d+):(\d+):(\d+) (\d{4})$/.exec(text)
  const month = match ? MONTHS.indexOf(match[1]) : -1
  if (month === -1) return null
  const [day, hour, minute, second, year] = match.slice(2).map(Number)
  return Date.UTC(year, month, day, hour, minute, second)
}

/**
 * True when two start time texts are the same instant, give or take
 * PID_START_TOLERANCE: the clock may be stepped (NTP) between two readings of
 * a live process. When either is not a date the two cannot be told apart,
 * and they count as the same: as when ps cannot say, the pid alone decides,
 * so a live run is never taken for gone.
 */
export function sameStart(a, b) {
  if (a === b) return true
  const [x, y] = [instantOf(a), instantOf(b)]
  return x === null || y === null || Math.abs(x - y) <= PID_START_TOLERANCE * 1000
}

/**
 * True when a process with this pid exists (ours or not) and, when `start` (the
 * start time the run recorded) is given, started then (within the tolerance):
 * a pid that started at another time was given to another process after the
 * run it names was gone. Without `start` (an event from before 0.6.0), or when
 * ps cannot tell the start now, the pid alone decides. Pids 0 and 1 are
 * nobody's run. `read` is for tests.
 */
export function alive(pid, start, read = pidStart) {
  if (!isRunPid(pid)) return false
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (error.code !== 'EPERM') return false
  }
  if (typeof start !== 'string' || !start) return true
  const now = read(pid)
  return now === null || sameStart(start, now)
}

/**
 * The mark of each state, one column wide like Gentle Shell's own (✓, ⧗):
 * emoji are two columns, and some terminals draw them badly.
 */
export const GLYPHS = { queued: '◌', starting: '⧗', running: '⧗', passed: '✓', failed: '✗', stopped: '⊘' }

/**
 * ci-local's own emoji, before the state mark, as Engram's 🧠 and RDD's 🌹
 * name theirs in Gentle Shell: a traffic light, the gate before a merge.
 */
export const BRAND = '🚦'

export function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

const quote = (arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`)

/** What an `end` event's result shows as. */
const FINISHED_AS = { passed: 'passed', interrupted: 'stopped' }

/**
 * queued, starting, running, passed, failed or stopped. A run with no end
 * event is stopped once its process is gone; until its turn (no `run`
 * event) it is queued while something is ahead of it, else starting.
 */
function stateOf({ end, run, lastQueued, isAlive }) {
  if (end) return FINISHED_AS[end.result] ?? 'failed'
  if (!isAlive(run.pid, run.pidStart)) return 'stopped'
  if (run.event === 'run') return 'running'
  const waiting = (lastQueued?.ahead ?? 0) > 0 || Boolean(lastQueued?.blockedBy)
  return waiting ? 'queued' : 'starting'
}

/**
 * The state of a run from its events: one of queued, starting, running,
 * passed, failed, stopped, with what the block shows. `isAlive` is
 * injectable for tests.
 */
export function runState(events, { now = Date.now(), isAlive = alive } = {}) {
  const queuedEvents = events.filter((event) => event.event === 'queued')
  const queued = queuedEvents[0] ?? null
  const lastQueued = queuedEvents.at(-1) ?? null
  // The run event, once the run has its turn; before, the queued one stands in.
  const run = events.find((event) => event.event === 'run') ?? events[0]
  const end = events.findLast((event) => event.event === 'end')
  // The step under way, or the last one that failed: a start with no ok after it.
  let step = null
  for (const event of events) {
    if (event.event === 'start' || event.event === 'fail') step = event
    if (event.event === 'ok') step = null
  }
  const fail = events.findLast((event) => event.event === 'fail') ?? null
  return {
    state: stateOf({ end, run, lastQueued, isAlive }),
    project: run.project,
    total: run.total,
    commit: run.commit,
    hasCommit: 'commit' in run,
    command: ['ci-local', ...(run.args ?? []).map(quote)].join(' '),
    logDir: run.logDir ?? null,
    pid: run.pid,
    // Its start time, from when it recorded it: tells it from a process given its pid since.
    pidStart: run.pidStart ?? null,
    // The Pi session that started the run (PI_SESSION_ID), or null.
    session: run.session ?? null,
    step,
    fail,
    end: end ?? null,
    devStack: end?.devStack ?? null,
    elapsedMs: end ? end.durationMs : now - Date.parse(run.ts),
    // Waiting for a turn: since when, where it stands, and whom for.
    hasRun: run.event === 'run',
    ahead: lastQueued?.ahead ?? 0,
    blockedBy: lastQueued?.blockedBy ?? null,
    waitingMs: queued ? now - Date.parse(queued.ts) : 0,
  }
}

const stepRef = (step) => `${step.step} (step ${step.index}/${step.total}`

/** The block, and its exit status. */
export function render(state, eventsFile) {
  const where = [`\`${state.command}\``, `project \`${state.project}\``]
  if (state.hasCommit) where.push(state.commit ? `\`${state.commit}\`` : 'not a git checkout')
  const time = duration(state.elapsedMs)
  const log = (step) => (step?.log ? ` · log: \`${step.log}\`` : '')

  if (state.state === 'queued' || state.state === 'starting') {
    const queued = state.state === 'queued'
    const behind = state.blockedBy ? `behind ${state.blockedBy.project} (${state.ahead} ahead)` : `${state.ahead} ahead`
    const waiting = duration(state.waitingMs)
    return {
      code: 3,
      lines: [
        queued ? `> ${BRAND} ${GLYPHS.queued} **ci-local** · queued · ${behind}` : `> ${BRAND} ${GLYPHS.starting} **ci-local** · starting`,
        `> ${[...where, queued ? `waiting ${waiting}` : `${waiting} so far`].join(' · ')}`,
        `> Follow it: \`tail -f ${eventsFile}\``,
      ],
    }
  }
  if (state.state === 'running') {
    const now = state.step ? ` · [${state.step.index}/${state.step.total}] ${state.step.step}` : ''
    const follow = [`Follow it: \`tail -f ${eventsFile}\``]
    if (state.logDir) follow.push(`step output: \`${state.logDir}\``)
    return {
      code: 3,
      lines: [`> ${BRAND} ${GLYPHS.running} **ci-local** · running${now}`, `> ${[...where, `${time} so far`].join(' · ')}`, `> ${follow.join(' · ')}`],
    }
  }
  if (state.state === 'passed') {
    const steps = `${state.total} step${state.total === 1 ? '' : 's'}`
    const dev = state.devStack === 'untouched' ? ' · Development stack untouched' : ''
    return {
      code: 0,
      lines: [`> ${BRAND} ${GLYPHS.passed} **ci-local** · passed`, `> ${where.join(' · ')}`, `> ${steps} · ${time} · every step passed${dev}.`],
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
    return { code: 1, lines: [`> ${BRAND} ${GLYPHS.failed} **ci-local** · failed`, `> ${where.join(' · ')}`, `> ${why}.`] }
  }
  // stopped
  let why
  if (state.end) {
    why = `Interrupted${state.step ? ` during: ${stepRef(state.step)})` : ''} · ${time}${log(state.step)}`
  } else if (!state.hasRun) {
    why = `Never started: process ${state.pid} is gone while queued (interrupted) · ${duration(state.waitingMs)}`
  } else {
    why = `No end: process ${state.pid} is gone (killed, or Docker froze)${
      state.step ? ` · during: ${stepRef(state.step)})` : ''
    }${log(state.step)}`
  }
  return { code: 4, lines: [`> ${BRAND} ${GLYPHS.stopped} **ci-local** · stopped`, `> ${where.join(' · ')}`, `> ${why}.`] }
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

/** True when this file is the script node runs (`node status.js FILE`), not an import. */
function isMain() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false // argv[1] is no file (`node -e`, an embedder): this file was imported
  }
}

if (isMain()) process.exitCode = main(process.argv[2])
