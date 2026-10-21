// The logic of the Pi extension, without Pi: which events file a session
// follows, the footer line, and when a run it watched has ended. The
// rendering and the states are those of `ci-local --status` (status.js).

import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import { BRAND, GLYPHS, alive, duration, lastRun, render, runState } from '@jals1212/ci-local/status'

const PROJECT_LINE = /^\s*CI_PROJECT=(?:"([a-z0-9][a-z0-9_-]*)"|'([a-z0-9][a-z0-9_-]*)'|([a-z0-9][a-z0-9_-]*))\s*(?:#.*)?$/

/**
 * The repository and CI_PROJECT of the nearest config at or above `cwd`.
 * Only a literal CI_PROJECT is read (the config is never run): null when it
 * is computed, or when there is no config.
 */
export function findProject(cwd, env = process.env) {
  const name = env.CI_LOCAL_CONFIG || 'ci-local.config.sh'
  let dir = cwd
  for (;;) {
    const config = join(dir, name)
    if (existsSync(config)) {
      let project = null
      for (const line of readFileSync(config, 'utf8').split('\n')) {
        const match = PROJECT_LINE.exec(line)
        if (match) project = match[1] ?? match[2] ?? match[3]
      }
      return project ? { repo: dir, project } : null
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** True for a real directory (no symlink) of this user that no one else can write. */
function privateDir(path) {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o022) === 0
  } catch {
    return false
  }
}

/**
 * The events file a run of `project` writes, as bin/ci-local decides it, or
 * null when there is none to follow (CI_LOCAL_EVENTS=off, or a refused
 * TMPDIR fallback). A relative CI_LOCAL_EVENTS is taken from
 * `repo` (bin/ci-local takes it from where it runs: the repository root, as
 * a rule). The TMPDIR fallback, a fixed name in a shared directory, is null
 * when it is there and is not a private directory of this user, as
 * bin/ci-local then writes no events.
 */
export function eventsFileFor(project, env = process.env, repo = process.cwd()) {
  const named = env.CI_LOCAL_EVENTS
  if (['0', 'off', 'false', 'no'].includes(named)) return null // runs write no events file
  if (named) return isAbsolute(named) ? named : join(repo, named)
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, 'ci-local', `${project}.ndjson`)
  if (env.HOME) return join(env.HOME, '.cache', 'ci-local', `${project}.ndjson`)
  const fallback = `${(env.TMPDIR || '/tmp').replace(/\/+$/, '')}/ci-local-${process.getuid?.() ?? 0}`
  const own = join(fallback, 'ci-local')
  // What exists of it now must be ours alone (bin/ci-local checks the same).
  for (const dir of [fallback, own]) {
    if ((existsSync(dir) || isSymlink(dir)) && !privateDir(dir)) return null
  }
  return join(own, `${project}.ndjson`)
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * The last run recorded in `file`: its state, the --status block, and a key
 * that tells one run from the next. Null when no run is recorded.
 */
export function readRun(file, options) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const events = lastRun(text)
  if (!events) return null
  const state = runState(events, options)
  return { state, block: render(state, file), key: `${events[0].ts}|${events[0].pid}` }
}

export const FINISHED = new Set(['passed', 'failed', 'stopped'])

/**
 * The parent of a live process; null when the process is gone, undefined when
 * `ps` cannot run here (so its parents cannot be known).
 */
export function parentPid(pid, { ps = 'ps' } = {}) {
  const out = spawnSync(ps, ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' })
  if (out.error) return undefined
  const ppid = Number.parseInt(out.stdout, 10)
  return out.status === 0 && Number.isInteger(ppid) ? ppid : null
}

/**
 * Whether a run is this session's own. A run that names the Pi session that
 * started it (ci-local records PI_SESSION_ID, which Pi gives its bash tool)
 * belongs to that session alone, wherever its process went. One that names
 * none (a Gentle AI background job, a terminal) is decided by the pids above
 * it that it recorded at start (`ancestors`), else, for a run that recorded
 * none, by its live process tree (launchedBy).
 */
export function ownsRun(
  run,
  { sessionId, sessionPid = process.pid, launched = (pid, pidStart) => launchedBy(pid, sessionPid, { pidStart }) }
) {
  const named = run.state.session
  if (named) return named === sessionId
  // The pids above the run when it started, while its session was still one:
  // they outlast the run's own parents (nohup, setsid). A pid is not checked
  // against its start time here, so a Pi process whose pid was given to another
  // later could be matched by a stale event: a rare mistake that costs a card.
  if (run.state.ancestors?.includes(sessionPid)) return true
  return launched(run.state.pid, run.state.pidStart)
}

/**
 * True when the process `pid` descends from `ancestor`: a run this session
 * started (its bash tool, or a background job of it) and so one it owns, as
 * Gentle AI's background jobs belong to the session that started them. A run
 * of another session in the same repository, or one started in a terminal,
 * is not, and neither is a process that is gone. When the parents of a live
 * run cannot be read (`ps` missing or failing), the run counts as this
 * session's: a card shown twice is better than one lost.
 */
export function launchedBy(pid, ancestor, { parentOf = parentPid, isAlive = alive, pidStart } = {}) {
  let current = parentOf(pid)
  if (current === undefined || (current === null && isAlive(pid, pidStart))) return true
  const seen = new Set()
  while (current !== null && current !== undefined && current > 1 && !seen.has(current)) {
    if (current === ancestor) return true
    seen.add(current)
    current = parentOf(current)
  }
  return false
}

/**
 * The key of the run the status line leaves out in a session that has just
 * started, or null. A run already over then is shown only while its result
 * is still undelivered: no session showed it finished (it ended with every
 * session of the repository closed). Once delivered it is old news, in a new
 * session or a resumed one. A reload keeps what the session had: the run
 * shows again only if this session is the one that showed it. A run in
 * flight is shown, and so is every run after it.
 */
export function staleAtStart(run, { reason, sessionId, delivered } = {}) {
  if (!run || !FINISHED.has(run.state.state) || delivered?.key !== run.key) return null
  if (reason === 'reload' && (!delivered.sessions.length || delivered.sessions.includes(sessionId))) return null
  return run.key
}

/**
 * Where sessions record the runs whose result they showed: one file per
 * session, `<events file>.delivered.d/<session>`, holding its last run and
 * its session. A session writes only its own file, so two sessions that see a
 * run end at once never overwrite each other. `<events file>.delivered` is
 * the 0.5.1 marker (the key alone), still read.
 */
const deliveredDir = (file) => `${file}.delivered.d`
const legacyDelivered = (file) => `${file}.delivered`

/** A session's file goes once it has gone unused this long. */
export const DELIVERED_TTL_MS = 30 * 24 * 3600 * 1000

const sessionFile = (file, session) => join(deliveredDir(file), (session || '-').replace(/[^A-Za-z0-9._-]/g, '_'))

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Whether the result of run `key` was delivered (some session showed it
 * finished), and the sessions that showed it: { key, sessions }, or null.
 * A 0.5.1 marker names no session.
 */
export function readDelivered(file, key) {
  let found = false
  const sessions = []
  if (readText(legacyDelivered(file))?.trim().split('\t')[0] === key) found = true
  let names = []
  try {
    names = readdirSync(deliveredDir(file))
  } catch {}
  for (const name of names) {
    if (name.endsWith('.tmp')) continue
    const [own, session] = (readText(join(deliveredDir(file), name)) ?? '').trim().split('\t')
    if (own !== key) continue
    found = true
    if (session && !sessions.includes(session)) sessions.push(session)
  }
  return found ? { key, sessions } : null
}

/**
 * Records that `session` showed the result of run `key`, in its own file
 * (a temporary file, then a rename), and removes the files of sessions
 * unused for DELIVERED_TTL_MS. A failure is ignored: the result is then
 * shown once more, never lost.
 */
export function markDelivered(file, key, session) {
  const dir = deliveredDir(file)
  const target = sessionFile(file, session)
  const temporary = `${target}.${process.pid}.tmp`
  try {
    mkdirSync(dir, { mode: 0o700 })
  } catch {}
  try {
    writeFileSync(temporary, `${key}\t${session ?? ''}\n`, { mode: 0o600 })
    renameSync(temporary, target)
  } catch {
    try {
      rmSync(temporary, { force: true })
    } catch {}
    return
  }
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (path !== target && Date.now() - statSync(path).mtimeMs > DELIVERED_TTL_MS) rmSync(path, { force: true })
    }
  } catch {}
}

/**
 * The status line of one session: the footer for each run read, leaving out
 * the run staleAtStart names, and recording each finished run it shows as
 * delivered. update() gives the footer (undefined: none) and whether it
 * changed since the last call.
 */
export function createStatusLine({ file, sessionId, reason }) {
  let stale = null
  try {
    const run = readRun(file)
    stale = staleAtStart(run, { reason, sessionId, delivered: run ? readDelivered(file, run.key) : null })
  } catch {
    // a half-written file: a run in progress, shown as usual
  }
  let shown
  let first = true
  return {
    update(run) {
      const footer = run && run.key !== stale ? footerText(run.state) : undefined
      const changed = first || footer !== shown
      first = false
      shown = footer
      if (changed && run && footer && FINISHED.has(run.state.state)) markDelivered(file, run.key, sessionId)
      return { footer, changed }
    },
  }
}

/** One short line for the footer: `🚦 ci-local · ✓ passed · 4m12s`. */
export function footerText(state) {
  // The state's glyph sits by the state, after the name.
  return `${BRAND} ci-local · ${GLYPHS[state.state] ?? GLYPHS.stopped} ${stateText(state)}`
}

/** The state of a run in a few words, as the footer says it after its glyph. */
export function stateText(state) {
  const time = duration(state.elapsedMs)
  switch (state.state) {
    case 'running':
      return state.step ? `[${state.step.index}/${state.step.total}] ${state.step.step} · ${time}` : `running · ${time}`
    case 'starting':
      return `starting · ${time}`
    case 'queued': {
      // blockedBy names the run at the head of the queue (the one running), the
      // same for every run waiting: how many are ahead tells them apart.
      const running = state.blockedBy?.project ? `${state.blockedBy.project} running` : ''
      if (!(state.ahead > 0)) return running ? `queued · ${running}` : 'queued'
      const ahead = `queued · ${state.ahead} ahead`
      return running ? `${ahead} (${running})` : ahead
    }
    case 'passed':
      return `passed · ${time}`
    case 'failed':
      return state.fail ? `failed at ${state.fail.step} · ${time}` : `failed · ${time}`
    default:
      return 'stopped'
  }
}

/**
 * What the model receives with the end card: where it comes from, then the
 * --status block. Without the first line a model takes the bare block for a
 * message from the user. (The transcript draws the card from its details.)
 */
export function cardContent(block, project) {
  return [
    `The ci-local Pi extension: a run of ${project} you saw start has ended (this is not a message from the user).`,
    '',
    ...block.lines,
  ].join('\n')
}

/**
 * Remembers the runs seen in flight. observe() is true once, when a run seen
 * in flight is seen finished: a run already over when the session started,
 * or one never seen in flight, is not news.
 */
export function createTracker() {
  const inFlight = new Set()
  const shown = new Set() // `${key}#${phase}` of every start card shown
  return {
    observe(run) {
      if (!run) return false
      if (!FINISHED.has(run.state.state)) {
        inFlight.add(run.key)
        return false
      }
      return inFlight.delete(run.key)
    },
    /**
     * The start card a run is due, once each: 'starting' while it waits for its
     * turn or starts, then 'started' once it runs its steps; null otherwise. A
     * run first seen already running is due 'started' only.
     */
    phase(run) {
      if (!run || FINISHED.has(run.state.state)) return null
      const due = run.state.state === 'running' ? 'started' : 'starting'
      const key = `${run.key}#${due}`
      if (shown.has(key) || (due === 'starting' && shown.has(`${run.key}#started`))) return null
      shown.add(key)
      return due
    },
    /** A start card already in the session (before a reload): not shown again. */
    remember(key, phase) {
      shown.add(`${key}#${phase}`)
    },
  }
}

/**
 * Where the end card can go now, as Gentle AI routes a background job's exit
 * notice: 'idle' (no run: wake the agent), 'run' (in an agent run, which spans
 * agent_start to agent_settled: steer it in), or 'hold' (busy without a run,
 * as when compacting: keep the card until a later tick or boundary). The
 * host's idle flag wins over a missed lifecycle event.
 */
export function routeFor({ idle, runActive }) {
  if (idle) return 'idle'
  return runActive ? 'run' : 'hold'
}

/** The longest a stored card waits for its run's process to exit before the wake. */
export const CARD_GRACE_MS = 10_000

/**
 * After the run's process has exited, the wait before ci-local wakes an idle
 * agent itself: a run started as a background job gets that job's own exit
 * notice first, and the stored card rides along with it.
 */
export const WAKE_GRACE_MS = 2_000

/** The wait before a delivery that failed is tried again. */
export const CARD_RETRY_MS = 30_000

/** Timed retries in a row; past them a delivery waits for an agent boundary. */
export const CARD_RETRY_LIMIT = 3

/** The hidden message that wakes an idle agent for the cards stored before it. */
export const WAKE_TEXT =
  'The ci-local Pi extension: a run you saw start has ended; its card is above. Act on its result if your task needs it.'

/**
 * How an action reaches the agent, as Gentle AI hands content to a parent:
 * - store: an idle agent gets the card in its conversation without a turn;
 * - steer: an agent in a run gets it before its next model call;
 * - wake: one hidden message then wakes an idle agent for what was stored.
 */
export function deliveryOptions(action) {
  return action.kind === 'store' ? { triggerTurn: false } : { deliverAs: 'steer', triggerTurn: true }
}

/**
 * The end cards of the runs a session saw, and the wake they owe, as Gentle
 * AI delivers a child's content to its parent (gentle-agents):
 * - idle agent: each card is stored at once, at the end event; one hidden wake
 *   follows, WAKE_GRACE_MS after the last run's process has exited
 *   (CARD_GRACE_MS after the card at most), unless a run started meanwhile,
 *   which already carries the stored cards;
 * - agent in a run: each card is steered in at once;
 * - busy without a run (compacting): everything waits.
 * A delivery that failed is tried again first, every CARD_RETRY_MS,
 * CARD_RETRY_LIMIT times in a row, then only after an agent boundary.
 *
 * next() hands out one action at a time; the caller reports it with done() or
 * failed().
 */
export function createDelivery({ isAlive = alive, now = Date.now } = {}) {
  const cards = [] // ended runs, oldest first
  let wake = null // { pid, pidStart, since, exitSeenAt } owed to an idle agent
  let failures = 0
  let retryAt = 0 // nothing before this; Infinity: until a boundary

  const wakeDue = () => {
    if (!wake) return false
    if (now() - wake.since >= CARD_GRACE_MS) return true
    if (isAlive(wake.pid, wake.pidStart)) return false
    wake.exitSeenAt ??= now()
    return now() - wake.exitSeenAt >= WAKE_GRACE_MS
  }

  return {
    ended(run) {
      cards.push(run)
    },
    next({ idle, runActive }) {
      if (now() < retryAt) return null
      const route = routeFor({ idle, runActive })
      if (route === 'hold') return null
      if (route === 'run') {
        wake = null // the run carries every stored card
        return cards.length ? { kind: 'steer', run: cards.shift() } : null
      }
      if (cards.length) return { kind: 'store', run: cards.shift() }
      if (wakeDue()) {
        wake = null
        return { kind: 'wake' }
      }
      return null
    },
    done(action) {
      failures = 0
      if (action.kind === 'store') wake = { pid: action.run.state.pid, pidStart: action.run.state.pidStart, since: now(), exitSeenAt: null }
    },
    failed(action) {
      if (action.kind === 'wake') wake = { pid: null, pidStart: null, since: -Infinity, exitSeenAt: null }
      else cards.unshift(action.run)
      failures += 1
      retryAt = failures > CARD_RETRY_LIMIT ? Infinity : now() + CARD_RETRY_MS
    },
    /** An agent boundary: what waited may go now, with a fresh retry count. */
    boundary() {
      failures = 0
      retryAt = 0
    },
  }
}

// ---------------------------------------------------------------- ci_local_run
//
// The ci_local_run tool starts a run itself, detached from Pi's tools, so no
// background job announces its end: the footer follows it and the end card
// (with its wake) reports it, as for any run this session starts. A run that
// ends before its first event (a usage or config error, `--list`, a busy
// machine with --no-wait) leaves no card: the tool reports it when it ends
// while the tool waits, exitCard when it ends later.

/** The directories of launch outputs, in the temporary directory. */
const LAUNCH_PREFIX = 'ci-local-run-'

/** How long a launch's output is kept: past it, the next launch removes it. */
export const LAUNCH_OUTPUT_TTL_MS = 7 * 24 * 3600 * 1000

/** Removes the launch outputs in `dir` older than `maxAgeMs`; never fails. */
export function pruneLaunchOutputs({ dir = tmpdir(), maxAgeMs = LAUNCH_OUTPUT_TTL_MS, now = Date.now() } = {}) {
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(LAUNCH_PREFIX)) continue
    const path = join(dir, name)
    try {
      const stat = lstatSync(path)
      if (stat.isDirectory() && now - stat.mtimeMs > maxAgeMs) rmSync(path, { recursive: true, force: true })
    } catch {
      // Gone already, or not ours to remove: left alone.
    }
  }
}

/** The ci-local a repository runs: its own (node_modules/.bin), else the one on PATH. */
export function ciLocalBin(repo) {
  const local = join(repo, 'node_modules', '.bin', 'ci-local')
  return existsSync(local) ? local : 'ci-local'
}

/**
 * Starts ci-local in `repo` with `args`, detached (its own process group, no
 * terminal, nothing Pi waits on), naming the session in PI_SESSION_ID so the
 * run is this session's (ownsRun). Its stdout and stderr go to a private file
 * (`output`). Once it ends, `ended` is true, with its exit status in `code`
 * or the signal that killed it in `signal`; when it could not start at all,
 * `error` says why and both are null. `exited` settles then.
 */
export function launchRun({ repo, args = [], sessionId, env = process.env, bin = ciLocalBin(repo) }) {
  pruneLaunchOutputs()
  const dir = mkdtempSync(join(tmpdir(), LAUNCH_PREFIX))
  const output = join(dir, 'output.log')
  const launch = { bin, output, pid: undefined, ended: false, code: null, signal: null, error: undefined, exited: undefined }
  let child
  try {
    const fd = openSync(output, 'a', 0o600)
    try {
      child = spawn(bin, args, { cwd: repo, detached: true, stdio: ['ignore', fd, fd], env: { ...env, PI_SESSION_ID: sessionId } })
    } finally {
      closeSync(fd) // the child has its own copy
    }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true }) // nothing ran: no output to keep
    throw error
  }
  launch.pid = child.pid
  launch.exited = new Promise((resolve) => {
    child.once('error', (error) => {
      launch.error = error.message
      launch.ended = true
      resolve(launch)
    })
    child.once('exit', (code, signal) => {
      Object.assign(launch, { code, signal, ended: true })
      resolve(launch)
    })
  })
  child.unref()
  return launch
}

/** How long ci_local_run waits for the run's first event. */
export const LAUNCH_WAIT_MS = 15_000

/**
 * Waits until the launched run shows in the events file (its pid in the last
 * run: `started`, with the run), ends first (`exited`), or `timeoutMs` passes
 * or `signal` aborts (`waiting`: a run of the same project may still own the
 * events file, and this one writes nothing before its turn). The run itself
 * is never stopped here.
 */
export async function waitForStart(launch, file, { timeoutMs = LAUNCH_WAIT_MS, pollMs = 250, signal } = {}) {
  const deadline = Date.now() + timeoutMs
  const aborted = new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }))
  for (;;) {
    // Snapshot "has it exited?" first, then read the events. A run that wrote
    // its events and exited in between is then found by its events (started),
    // never taken for one that exited before writing any.
    const ended = launch.ended
    let run = null
    try {
      run = file ? readRun(file) : null
    } catch {
      // A half-written file: the next look reads it whole.
    }
    if (run && launch.pid !== undefined && run.state.pid === launch.pid) return { kind: 'started', run }
    if (ended) return { kind: 'exited' }
    if (Date.now() >= deadline || signal?.aborted) return { kind: 'waiting' }
    await Promise.race([launch.exited, aborted, new Promise((resolve) => setTimeout(resolve, pollMs))])
  }
}

/** How much of the end of a launch's output outputTail reads. */
const TAIL_BYTES = 64 * 1024

/** The last `count` lines of a launch's output, from its last TAIL_BYTES (none when it cannot be read). */
export function outputTail(output, count = 20) {
  let fd
  try {
    fd = openSync(output, 'r')
    const size = fstatSync(fd).size
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    const lines = buffer.toString('utf8').trimEnd().split('\n')
    if (length < size) lines.shift() // cut mid-line
    return lines.slice(-count)
  } catch {
    return []
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** How a launch ended, in a few words: `status 2`, or `killed by SIGTERM`. */
const howEnded = ({ code, signal }) => (signal ? `killed by ${signal}` : `status ${code}`)

/** The first line of ci_local_run's answer for a launch that ended before its run showed. */
function endedLine(launch) {
  if (launch.code === 0) return 'ci-local finished (status 0) without a run'
  const verb = launch.signal ? 'was' : 'exited with'
  return `ci-local ${verb} ${howEnded(launch)} before a run started`
}

/**
 * What ci_local_run tells the agent of a launch and how it stands. followed:
 * whether this session follows the run (a footer and an end card will come).
 */
export function launchReport(result, launch, project, { followed = true } = {}) {
  const where = `Output: ${launch.output}.`
  const follow = followed
    ? 'The footer follows it and its end card reaches you when it ends: do not poll, sleep or run `ci-local --status`.'
    : 'This session cannot follow it (no UI, or no events file to read), so no footer or end card will come: read its output, or ask ci_local_status.'
  if (result.kind === 'started')
    return `ci-local started (pid ${launch.pid}) for ${project}: ${stateText(result.run.state)}. ${follow} ${where}`
  if (result.kind === 'waiting') {
    const why = followed ? `: another run of ${project} may hold its events file until it ends` : ''
    return `ci-local launched (pid ${launch.pid}) for ${project}, no event yet${why}. ${follow} ${where}`
  }
  const tail = outputTail(launch.output)
  return [
    `${endedLine(launch)}. ${where}`,
    ...(tail.length ? ['', '```', ...tail, '```'] : []),
  ].join('\n')
}

/**
 * A launch that ended after ci_local_run returned without the session ever
 * seeing its run (it wrote no event, or one the session never read before a
 * later run took the events file), as a run for the end card
 * (createDelivery): failed, with the end of its output, which says what
 * happened either way.
 */
export function exitCard({ pid, code, signal = null, output, tail = outputTail(output, 10) }) {
  // Status 0: its run passed, or it had no run to make; anything else failed.
  const state = code === 0 ? 'passed' : 'failed'
  return {
    key: `launch:${pid}`,
    state: { state, pid, pidStart: null },
    block: {
      code: code === 0 ? 0 : 1,
      lines: [
        `> ${BRAND} ${GLYPHS[state]} **ci-local** · ended before this session saw its run`,
        `> ${howEnded({ code, signal })} · pid ${pid} · output \`${output}\``,
        ...tail.map((line) => `> ${line}`),
      ],
    },
  }
}

// Herdr (https://herdr.dev): in a pane Herdr runs, the footer line is also the
// pane's `$ci` metadata token, so a row `["$ci"]` in Herdr's Agents sidebar
// shows the run. A token is display only: it never touches the agent's state.

/** The token's name, as a sidebar row names it: `$ci`. */
export const HERDR_TOKEN = 'ci'
/** Who reports the token. No sequence numbers: one sender, one report at a time. */
export const HERDR_SOURCE = 'ci-local'
/** Herdr drops the token this long after the last report: a Pi gone leaves nothing behind. */
export const HERDR_TTL_MS = 30_000
/** A token unchanged is reported again this often, well inside its TTL. */
export const HERDR_REFRESH_MS = 10_000
/** How long a run's result stays in the sidebar after the run ends. */
export const HERDR_RESULT_MS = 5 * 60_000
/** Herdr keeps at most this many characters of a token. */
export const HERDR_TOKEN_MAX = 80

/** The pane and socket of the Herdr pane this process runs in, or null outside one. */
export function herdrPane(env = process.env) {
  const pane = env.HERDR_PANE_ID?.trim()
  const socket = env.HERDR_SOCKET_PATH?.trim()
  return env.HERDR_ENV === '1' && pane && socket ? { pane, socket } : null
}

function clip(text) {
  const chars = [...text]
  return chars.length <= HERDR_TOKEN_MAX ? text : chars.slice(0, HERDR_TOKEN_MAX - 1).join('') + '…'
}

/**
 * What the token says for a run: the footer line while it is in flight, and
 * its result for HERDR_RESULT_MS after it ended (by its end event; a run that
 * stopped without one, from when this session saw it stop). Null otherwise:
 * no run, or a result older than that, or a run found already stopped.
 */
export function createHerdrLine({ now = Date.now } = {}) {
  let flying // the key of the last run seen in flight
  const endedAt = new Map()
  return {
    text(run) {
      if (!run) return null
      if (!FINISHED.has(run.state.state)) {
        flying = run.key
        return clip(footerText(run.state))
      }
      if (!endedAt.has(run.key)) {
        const ended = Date.parse(run.state.end?.ts ?? '')
        endedAt.clear()
        endedAt.set(run.key, Number.isFinite(ended) ? ended : run.key === flying ? now() : null)
      }
      const ended = endedAt.get(run.key)
      return ended !== null && now() - ended < HERDR_RESULT_MS ? clip(footerText(run.state)) : null
    },
  }
}

/** The socket request that sets the token (with its TTL), or clears it (null). */
export function herdrReport(pane, value) {
  const params = { pane_id: pane, source: HERDR_SOURCE, tokens: { [HERDR_TOKEN]: value } }
  if (value !== null) params.ttl_ms = HERDR_TTL_MS
  return { method: 'pane.report_metadata', params }
}

let herdrRequests = 0

/**
 * A sender of the token to Herdr's socket (one JSON line, one reply): resolves
 * true when Herdr accepted it, false on any error or after `timeoutMs`.
 */
export function herdrSend({ pane, socket }, { timeoutMs = 2000 } = {}) {
  return (value) =>
    new Promise((resolve) => {
      const id = `ci-local-${process.pid}-${++herdrRequests}`
      let reply = ''
      let done = false
      const finish = (ok) => {
        if (done) return
        done = true
        clearTimeout(timer)
        conn.destroy()
        resolve(ok)
      }
      const conn = createConnection(socket)
      const timer = setTimeout(() => finish(false), timeoutMs)
      timer.unref?.()
      conn.on('connect', () => conn.write(JSON.stringify({ id, ...herdrReport(pane, value) }) + '\n'))
      conn.on('data', (data) => {
        reply += data
        const end = reply.indexOf('\n')
        if (end < 0) return
        try {
          const answer = JSON.parse(reply.slice(0, end))
          finish(answer.id === id && answer.result?.type === 'ok')
        } catch {
          finish(false)
        }
      })
      conn.on('error', () => finish(false))
      conn.on('close', () => finish(false))
    })
}

/**
 * Keeps Herdr's token in step with `update(value)` (null clears it): a report
 * when the value changes, again every HERDR_REFRESH_MS while it stays, one
 * report at a time (the latest value waits for the one on its way). A failed
 * report is tried again at the next update. `idle()` resolves once nothing is
 * on its way.
 */
export function createHerdrPublisher({ send, now = Date.now, refreshMs = HERDR_REFRESH_MS }) {
  let shown = null // what Herdr has
  let sentAt = 0
  let inFlight = null
  let pending // the value to report once inFlight is done
  const update = (value) => {
    if (inFlight) {
      pending = value
      return
    }
    const due = value !== shown || (value !== null && now() - sentAt >= refreshMs)
    if (!due) return
    let sending
    try {
      sending = Promise.resolve(send(value))
    } catch {
      sending = Promise.resolve(false)
    }
    inFlight = sending
      .catch(() => false)
      .then((ok) => {
        if (ok) {
          shown = value
          sentAt = now()
        }
        inFlight = null
        if (pending !== undefined) {
          const next = pending
          pending = undefined
          update(next)
        }
      })
  }
  return {
    update,
    async idle() {
      while (inFlight) await inFlight
    },
  }
}
