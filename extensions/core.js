// The logic of the Pi extension, without Pi: which events file a session
// follows, the footer line, and when a run it watched has ended. The
// rendering and the states are those of `ci-local --status` (status.js).

import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import { alive, duration, lastRun, render, runState } from '../status.js'

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

/** One short line for the footer. */
export function footerText(state) {
  const time = duration(state.elapsedMs)
  switch (state.state) {
    case 'running':
      return state.step
        ? `🐳 ci-local [${state.step.index}/${state.step.total}] ${state.step.step} · ${time}`
        : `🐳 ci-local running · ${time}`
    case 'starting':
      return `🐳 ci-local starting · ${time}`
    case 'queued': {
      const behind = state.blockedBy?.project
      return behind ? `⏳ ci-local queued · behind ${behind}` : '⏳ ci-local queued'
    }
    case 'passed':
      return `✅ ci-local passed · ${time}`
    case 'failed':
      return state.fail ? `❌ ci-local failed at ${state.fail.step} · ${time}` : `❌ ci-local failed · ${time}`
    default:
      return '⚠️ ci-local stopped'
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
  return {
    observe(run) {
      if (!run) return false
      if (!FINISHED.has(run.state.state)) {
        inFlight.add(run.key)
        return false
      }
      return inFlight.delete(run.key)
    },
  }
}

/**
 * How the end card reaches the agent: an idle agent is woken to act on the
 * result; a busy one gets it within its current work (steer), not once the
 * whole task is over as a follow-up would.
 */
export function deliveryFor(idle) {
  return idle ? { triggerTurn: true } : { deliverAs: 'steer' }
}

/** The longest an ended run's card waits for the run's process to exit. */
export const CARD_GRACE_MS = 10_000

/**
 * Holds the card of an ended run until its process has exited (the cleanup
 * after the end event, then the exit), CARD_GRACE_MS at most. A run started
 * with a background job then reaches the agent with that job's own exit
 * notice, in one turn, instead of each opening one.
 */
export function createCardQueue({ isAlive = alive, now = Date.now } = {}) {
  let pending = null
  return {
    add(run) {
      pending = { run, since: now() }
    },
    take() {
      if (!pending) return null
      if (isAlive(pending.run.state.pid) && now() - pending.since < CARD_GRACE_MS) return null
      const { run } = pending
      pending = null
      return run
    },
  }
}
