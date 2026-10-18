/** One line of an events file (see "Events contract" in the README): `ts` and `event`, then the fields of that event. */
export interface StatusEvent {
  /** ISO 8601, UTC, milliseconds. */
  ts: string
  event: 'queued' | 'run' | 'start' | 'ok' | 'fail' | 'end' | (string & {})
  /** The events contract version, on `queued` and `run`; absent from events of before it. */
  schema?: number
  project?: string
  pid?: number
  pidStart?: string | null
  commit?: string | null
  args?: string[]
  logDir?: string | null
  session?: string | null
  ancestors?: number[]
  /** Readers ignore the fields they do not know. */
  [field: string]: unknown
}

/** A step event (`start`, `ok`, `fail`) as `RunState.step` and `RunState.fail` hold it. */
export interface StepEvent extends StatusEvent {
  step: string
  /** From 1. */
  index: number
  total: number
  exitCode?: number
  durationMs?: number
  log?: string
  deviates?: string
}

export interface EndEvent extends StatusEvent {
  result: 'passed' | 'failed' | 'interrupted' | (string & {})
  devStack?: 'untouched' | 'changed' | 'none' | (string & {})
  deviations?: number
  durationMs: number
}

export type RunStateName = 'queued' | 'starting' | 'running' | 'passed' | 'failed' | 'stopped'

export interface RunState {
  state: RunStateName
  /** The events contract version the run wrote; null for events from before it. */
  schema: number | null
  project: string
  /** Steps to run (absent while the run only has its `queued` event). */
  total: number | undefined
  /** 12 characters; null outside git; undefined in events from before 0.4.0. */
  commit: string | null | undefined
  /** The events carry a `commit` field at all. */
  hasCommit: boolean
  /** The command line, as `ci-local --only a`. */
  command: string
  logDir: string | null
  pid: number
  /** The run's start time, as it recorded it; null when it did not. */
  pidStart: string | null
  /** The Pi session that started the run (`PI_SESSION_ID`), or null. */
  session: string | null
  /** The pids above the run when it started, nearest first, or null. */
  ancestors: number[] | null
  deviations: { count: number; steps: string[] }
  /** The step under way, or the last one that failed. */
  step: StepEvent | null
  /** The last `fail` event. */
  fail: StepEvent | null
  end: EndEvent | null
  devStack: string | null
  /** Since the first event while the run goes; the run's `durationMs` once it ended. */
  elapsedMs: number
  /** The run has its turn (a `run` event). */
  hasRun: boolean
  /** Live runs before it, while it waits. */
  ahead: number
  blockedBy: { project: string; pid: number } | null
  /** Since its first `queued` event. */
  waitingMs: number
}

export interface StatusBlock {
  /** The exit status of `--status`: 0 passed, 1 failed, 3 queued, starting or running, 4 stopped. */
  code: number
  /** The Markdown block, one string per line. */
  lines: string[]
}

/** Reads the start time of a process (null when it is gone or `ps` cannot say). */
export type PidStartReader = (pid: number) => string | null

/** How far apart two readings of one process's start time may be, in seconds. */
export const PID_START_TOLERANCE: number

/** The events of the last run in an events file's text, or null when it holds none. */
export function lastRun(text: string): StatusEvent[] | null

export function createPidStartReader(options?: {
  spawn?: (...args: any[]) => { error?: unknown; status: number | null; stdout: string }
  now?: () => number
  /** Milliseconds a start time is kept. */
  ttl?: number
}): PidStartReader

/** The start time of a process, as `ps -o lstart=` gives it in the C locale and UTC. */
export const pidStart: PidStartReader

/** True when two start time texts are the same instant, give or take PID_START_TOLERANCE. */
export function sameStart(a: string, b: string): boolean

/** True when the process exists and, given `start`, started then. */
export function alive(pid: number, start?: string | null, read?: PidStartReader): boolean

/** The mark of each state, one column wide. */
export const GLYPHS: Record<RunStateName, string>

/** ci-local's own emoji, before the state mark. */
export const BRAND: string

/** `45s`, `3m05s`. */
export function duration(ms: number): string

/** The state of a run from the events `lastRun` returned. */
export function runState(events: StatusEvent[], options?: { now?: number; isAlive?: (pid: number, start?: string | null) => boolean }): RunState

/** The `--status` block of a state, and its exit status. */
export function render(state: RunState, eventsFile: string): StatusBlock
