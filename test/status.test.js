// --status: the state of the last run, read from its events file, as the
// short Markdown block an agent or a person pastes while waiting and when it
// ends. Runs use test/fixture/fake-docker (no daemon); the running and
// stopped states come from events files written here.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { alive, createPidStartReader, pidStart, runState } from '../status.js'

// The user's settings (~/.ci-local/config.json, a CI_LOCAL_MAX_RUNS in the
// shell) must not change what these runs do: a test that wants them sets them.
process.env.CI_LOCAL_USER_CONFIG = 'off'
delete process.env.CI_LOCAL_MAX_RUNS

const BIN = fileURLToPath(new URL('../bin/ci-local', import.meta.url))
const FAKE_DOCKER = fileURLToPath(new URL('./fixture/fake-docker/', import.meta.url))
chmodSync(join(FAKE_DOCKER, 'docker'), 0o755)

function project(plan) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-local-status-'))
  writeFileSync(join(dir, '.nvmrc'), '24.21.0\n')
  writeFileSync(
    join(dir, 'ci-local.config.sh'),
    ['CI_PROJECT=ci-local-selftest', 'CI_JOBS=(a b)', 'ci_plan() {', ...plan.map((line) => `  ${line}`), '}', ''].join('\n')
  )
  return dir
}

function baseEnv(cache, env) {
  const base = { ...process.env }
  delete base.CI_LOCAL_QUIET
  delete base.CI_LOCAL_EVENTS
  delete base.PI_SESSION_ID
  delete base.CI_LOCAL_QUEUE
  delete base.CI_LOCAL_QUEUE_POLL
  // The queue in a directory of its own: never the real one.
  return { ...base, XDG_CACHE_HOME: cache, CI_LOCAL_QUEUE_DIR: mkdtempSync(join(tmpdir(), 'q-')), PATH: `${FAKE_DOCKER}:${process.env.PATH}`, ...env }
}

/** A run, to its end. */
function run(args, { cwd, cache, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn('bash', [BIN, ...args], { cwd, env: baseEnv(cache, env) })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (err += chunk))
    child.on('close', (status) => resolve({ status, out, err }))
  })
}

/** --status, which returns at once. */
function status(args, { cwd = tmpdir(), cache = mkdtempSync(join(tmpdir(), 'c-')), env = {} } = {}) {
  const result = spawnSync('bash', [BIN, '--status', ...args], { cwd, encoding: 'utf8', env: baseEnv(cache, env) })
  return { status: result.status, out: result.stdout, err: result.stderr }
}

const defaultEvents = (cache) => join(cache, 'ci-local', 'ci-local-selftest.ndjson')

/** An events file with these lines, as a run would have written them. */
function eventsFile(events) {
  const file = join(mkdtempSync(join(tmpdir(), 'ev-')), 'events.ndjson')
  writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n')
  return file
}

const runEvent = (fields = {}) => ({
  ts: new Date(Date.now() - 125_000).toISOString(),
  event: 'run',
  project: 'myapp-ci',
  jobs: ['quality', 'tests'],
  total: 8,
  version: '0.4.0',
  pid: process.pid,
  commit: 'abc123def456',
  args: ['--quiet'],
  logDir: '/tmp/myapp-ci-logs.X1',
  ...fields,
})

/** A pid that no process has. */
function deadPid() {
  const child = spawnSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' })
  return Number(child.stdout.trim())
}

test('a run writes its events to the cache by default, and says where', async () => {
  const dir = project(["ci_step box One 'true'"])
  const cache = mkdtempSync(join(tmpdir(), 'c-'))
  const { status: code, out, err } = await run([], { cwd: dir, cache })
  assert.equal(code, 0, err)
  const file = defaultEvents(cache)
  assert.match(out, new RegExp(`\\nEvents: ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(ci-local --status\\)\\n`))
  const events = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(
    events.map(({ event }) => event),
    ['queued', 'run', 'start', 'ok', 'end']
  )
})

test('CI_LOCAL_EVENTS=off writes no events file', async () => {
  const dir = project(["ci_step box One 'true'"])
  const cache = mkdtempSync(join(tmpdir(), 'c-'))
  const { status: code, out } = await run([], { cwd: dir, cache, env: { CI_LOCAL_EVENTS: 'off' } })
  assert.equal(code, 0)
  assert.doesNotMatch(out, /\nEvents: /)
  assert.equal(existsSync(join(cache, 'ci-local')), false)
})

test('a default events file that cannot be written warns, and the run goes on', async () => {
  const dir = project(["ci_step box One 'true'"])
  const cache = mkdtempSync(join(tmpdir(), 'c-'))
  writeFileSync(join(cache, 'ci-local'), 'a file, not a directory')
  const { status: code, err } = await run([], { cwd: dir, cache })
  assert.equal(code, 0)
  assert.match(err, /ci-local: cannot write the events file .*: --status will not see this run\n/)
})

test('--status after a passing run: the passed block, status 0', async () => {
  const dir = project(["ci_step box One 'true'", "ci_step box Two 'true'"])
  const cache = mkdtempSync(join(tmpdir(), 'c-'))
  await run(['--only', 'a'], { cwd: dir, cache })
  const { status: code, out } = status([], { cwd: dir, cache })
  assert.equal(code, 0)
  const lines = out.trimEnd().split('\n')
  assert.equal(lines.length, 3, out)
  assert.equal(lines[0], '> 🚦 ✓ **ci-local** · passed')
  assert.equal(lines[1], '> `ci-local --only a` · project `ci-local-selftest` · not a git checkout')
  assert.match(lines[2], /^> 2 steps · \d+s · every step passed\.$/)
})

test('--status after a failing --quiet run: the failed step and its log, status 1', async () => {
  const dir = project(["ci_step box One 'true'", "ci_step box 'Lint it' 'exit 3'", "ci_step box Never 'true'"])
  const cache = mkdtempSync(join(tmpdir(), 'c-'))
  await run(['--quiet'], { cwd: dir, cache })
  const { status: code, out } = status([], { cwd: dir, cache })
  assert.equal(code, 1)
  const lines = out.trimEnd().split('\n')
  assert.equal(lines[0], '> 🚦 ✗ **ci-local** · failed')
  assert.equal(lines[1], '> `ci-local --quiet` · project `ci-local-selftest` · not a git checkout')
  assert.match(lines[2], /^> Failed at: Lint it \(step 2\/3, exit 3\) · \d+s · log: `.+\/02-lint-it\.log`\.$/)
})

test('--status names the commit of a git checkout', async () => {
  const dir = project(["ci_step box One 'true'"])
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  git('init', '-q')
  git('add', '.')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  const sha = git('rev-parse', '--short=12', 'HEAD').stdout.trim()
  const cache = mkdtempSync(join(tmpdir(), 'c-'))
  await run([], { cwd: dir, cache })
  const { out } = status([], { cwd: dir, cache })
  assert.match(out, new RegExp(`\\n> \`ci-local\` · project \`ci-local-selftest\` · \`${sha}\`\\n`))
})

test('--status while a run is in flight: the running block with the step, status 3', () => {
  const file = eventsFile([
    runEvent(),
    { ts: new Date().toISOString(), event: 'start', step: 'Build the runner image', index: 1, total: 8 },
    { ts: new Date().toISOString(), event: 'ok', step: 'Build the runner image', index: 1, total: 8, durationMs: 5 },
    { ts: new Date().toISOString(), event: 'start', step: 'pnpm run lint', index: 2, total: 8 },
  ])
  const { status: code, out } = status(['--events', file])
  assert.equal(code, 3)
  const lines = out.split('\n')
  assert.equal(lines.length, 4, out)
  assert.equal(lines[0], '> 🚦 ⧗ **ci-local** · running · [2/8] pnpm run lint')
  assert.match(lines[1], /^> `ci-local --quiet` · project `myapp-ci` · `abc123def456` · 2m0[56]s so far$/)
  assert.equal(lines[2], `> Follow it: \`tail -f ${file}\` · step output: \`/tmp/myapp-ci-logs.X1\``)
  assert.equal(lines[3], '')
})

test('--status when the run’s process is gone without an end: stopped, status 4', () => {
  const file = eventsFile([
    runEvent({ pid: deadPid(), args: [], logDir: null }),
    { ts: new Date().toISOString(), event: 'start', step: 'pnpm test', index: 5, total: 8 },
  ])
  const { status: code, out } = status(['--events', file])
  assert.equal(code, 4)
  const lines = out.trimEnd().split('\n')
  assert.equal(lines[0], '> 🚦 ⊘ **ci-local** · stopped')
  assert.equal(lines[1], '> `ci-local` · project `myapp-ci` · `abc123def456`')
  assert.match(lines[2], /^> No end: process \d+ is gone \(killed, or Docker froze\) · during: pnpm test \(step 5\/8\)\.$/)
})

test('--status after an interrupted run: stopped, status 4', () => {
  const file = eventsFile([
    runEvent(),
    { ts: runEvent().ts, event: 'start', step: 'pnpm test', index: 5, total: 8 },
    {
      ts: runEvent().ts,
      event: 'fail',
      step: 'pnpm test',
      index: 5,
      total: 8,
      exitCode: 143,
      durationMs: 9000,
      log: '/tmp/myapp-ci-logs.X1/05-pnpm-test.log',
    },
    { ts: runEvent().ts, event: 'end', result: 'interrupted', durationMs: 61_000, devStack: 'untouched' },
  ])
  const { status: code, out } = status(['--events', file])
  assert.equal(code, 4)
  assert.match(out, /^> 🚦 ⊘ \*\*ci-local\*\* · stopped\n/)
  assert.match(out, /\n> Interrupted during: pnpm test \(step 5\/8\) · 1m01s · log: `\/tmp\/myapp-ci-logs\.X1\/05-pnpm-test\.log`\.\n$/)
})

test('--status after a run that changed the development stack: failed, and says so', () => {
  const file = eventsFile([
    runEvent(),
    { ts: runEvent().ts, event: 'end', result: 'failed', durationMs: 3000, devStack: 'changed' },
  ])
  const { status: code, out } = status(['--events', file])
  assert.equal(code, 1)
  assert.match(out, /\n> The development stack changed during the run · 3s\.\n$/)
})

test('--status says when the development stack was left alone', () => {
  const file = eventsFile([
    runEvent({ total: 1 }),
    { ts: runEvent().ts, event: 'end', result: 'passed', durationMs: 3000, devStack: 'untouched' },
  ])
  const { out } = status(['--events', file])
  assert.match(out, /\n> 1 step · 3s · every step passed · Development stack untouched\.\n$/)
})

const deviating = (step, index, reason = 'leaves out a spec') => [
  { ts: runEvent().ts, event: 'start', step, index, total: 3, deviates: reason },
  { ts: runEvent().ts, event: 'ok', step, index, total: 3, durationMs: 5, deviates: reason },
]

test('--status names a step that deviates from its workflow step, on the summary line', () => {
  const file = eventsFile([
    runEvent({ total: 3 }),
    ...deviating('pnpm run test:integration', 1),
    { ts: runEvent().ts, event: 'end', result: 'passed', durationMs: 3000, devStack: 'untouched', deviations: 1 },
  ])
  const { status: code, out } = status(['--events', file])
  assert.equal(code, 0)
  const lines = out.trimEnd().split('\n')
  assert.equal(lines.length, 3, out)
  assert.equal(lines[2], '> 3 steps · 3s · every step passed · 1 deviation (pnpm run test:integration) · Development stack untouched.')
})

test('--status lists the first two deviating steps, then …', () => {
  const end = (deviations) => ({ ts: runEvent().ts, event: 'end', result: 'passed', durationMs: 3000, deviations })
  const two = eventsFile([runEvent({ total: 3 }), ...deviating('a', 1), ...deviating('b', 2), end(2)])
  assert.equal(status(['--events', two]).out.trimEnd().split('\n')[2], '> 3 steps · 3s · every step passed · 2 deviations (a, b).')
  const three = eventsFile([runEvent({ total: 3 }), ...deviating('a', 1), ...deviating('b', 2), ...deviating('c', 3), end(3)])
  assert.equal(status(['--events', three]).out.trimEnd().split('\n')[2], '> 3 steps · 3s · every step passed · 3 deviations (a, b, …).')
})

test('--status names a deviating step once, though its start and ok both carry the reason', () => {
  const file = eventsFile([
    runEvent({ total: 1 }),
    ...deviating('a', 1),
    { ts: runEvent().ts, event: 'end', result: 'passed', durationMs: 3000, deviations: 1 },
  ])
  assert.match(status(['--events', file]).out, /every step passed · 1 deviation \(a\)\.\n$/)
})

test('--status of events from before deviations (no deviates, no deviations) says what it did', () => {
  const file = eventsFile([
    runEvent({ total: 1 }),
    { ts: runEvent().ts, event: 'start', step: 'a', index: 1, total: 1 },
    { ts: runEvent().ts, event: 'ok', step: 'a', index: 1, total: 1, durationMs: 5 },
    { ts: runEvent().ts, event: 'end', result: 'passed', durationMs: 3000, devStack: 'untouched' },
  ])
  assert.match(status(['--events', file]).out, /\n> 1 step · 3s · every step passed · Development stack untouched\.\n$/)
})

test('--status with "deviations": 0 on end says nothing of deviations', () => {
  const file = eventsFile([runEvent({ total: 1 }), { ts: runEvent().ts, event: 'end', result: 'passed', durationMs: 3000, deviations: 0 }])
  assert.match(status(['--events', file]).out, /\n> 1 step · 3s · every step passed\.\n$/)
})

test('a real run with a deviating step: --status names it', async () => {
  const dir = project(["ci_step box One 'true'", "ci_step box 'npm run e2e' --deviates 'leaves out a spec' 'true'"])
  const cache = mkdtempSync(join(tmpdir(), 'c-'))
  const { status: ran, err } = await run([], { cwd: dir, cache })
  assert.equal(ran, 0, err)
  assert.match(status([], { cwd: dir, cache }).out, /\n> 2 steps · \d+s · every step passed · 1 deviation \(npm run e2e\)\.\n$/)
})

test('--status without an events file: says so, status 2', () => {
  const dir = project(["ci_step box One 'true'"])
  const { status: code, out, err } = status([], { cwd: dir })
  assert.equal(code, 2)
  assert.equal(out, '')
  assert.match(err, /ci-local: no run recorded in .*ci-local-selftest\.ndjson\n/)
})

test('--status with --events needs no config, nor Docker', () => {
  const file = eventsFile([runEvent(), { ts: runEvent().ts, event: 'end', result: 'passed', durationMs: 1000 }])
  const dir = mkdtempSync(join(tmpdir(), 'no-config-'))
  mkdirSync(join(dir, 'empty-path'))
  // node (which renders the block) is found; no docker, fake or real, is.
  const { status: code, out } = status(['--events', file], {
    cwd: dir,
    env: { PATH: `${join(dir, 'empty-path')}:${dirname(process.execPath)}:/usr/bin:/bin` },
  })
  assert.equal(code, 0)
  assert.match(out, /^> 🚦 ✓ \*\*ci-local\*\* · passed\n/)
})

test('--status refuses the options that run steps', () => {
  const { status: code, err } = status(['--only', 'a'], { cwd: project(["ci_step box One 'true'"]) })
  assert.equal(code, 2)
  assert.match(err, /ci-local: --status takes only --events/)
})

const queuedEvent = (fields = {}) => ({
  ts: new Date(Date.now() - 65_000).toISOString(),
  event: 'queued',
  project: 'myapp-ci',
  version: '0.4.0',
  pid: process.pid,
  commit: 'abc123def456',
  args: ['--quiet'],
  logDir: null,
  ahead: 2,
  blockedBy: { project: 'other-ci', pid: 4242 },
  ...fields,
})

test('--status on a run waiting its turn: the queued block, status 3', () => {
  const file = eventsFile([queuedEvent({ ahead: 1 }), queuedEvent({ ahead: 2 })])
  const { status: code, out } = status(['--events', file])
  assert.equal(code, 3)
  const lines = out.split('\n')
  assert.equal(lines.length, 4, out)
  assert.equal(lines[0], '> 🚦 ◌ **ci-local** · queued · behind other-ci (2 ahead)')
  assert.match(lines[1], /^> `ci-local --quiet` · project `myapp-ci` · `abc123def456` · waiting 1m0[56]s$/)
  assert.equal(lines[2], `> Follow it: \`tail -f ${file}\``)
  assert.equal(lines[3], '')
})

test('--status on a run that took its turn but has not started: starting, status 3', () => {
  const file = eventsFile([queuedEvent({ ahead: 0, blockedBy: null, commit: null, args: [] })])
  const { status: code, out } = status(['--events', file])
  assert.equal(code, 3)
  const lines = out.trimEnd().split('\n')
  assert.equal(lines[0], '> 🚦 ⧗ **ci-local** · starting')
  assert.match(lines[1], /^> `ci-local` · project `myapp-ci` · not a git checkout · 1m0[56]s so far$/)
  assert.equal(lines[2], `> Follow it: \`tail -f ${file}\``)
})

test('--status on a run that has taken its turn: running, counted from the run event', () => {
  const file = eventsFile([
    queuedEvent({ ts: new Date(Date.now() - 600_000).toISOString() }),
    runEvent(),
    { ts: new Date().toISOString(), event: 'start', step: 'pnpm test', index: 1, total: 8 },
  ])
  const { status: code, out } = status(['--events', file])
  assert.equal(code, 3)
  assert.match(out, /^> 🚦 ⧗ \*\*ci-local\*\* · running · \[1\/8\] pnpm test\n> .* · 2m0[56]s so far\n/)
})

test('--status on a queued run whose process is gone: stopped before it started, status 4', () => {
  const file = eventsFile([queuedEvent({ pid: deadPid() })])
  const { status: code, out } = status(['--events', file])
  assert.equal(code, 4)
  const lines = out.trimEnd().split('\n')
  assert.equal(lines[0], '> 🚦 ⊘ **ci-local** · stopped')
  assert.equal(lines[1], '> `ci-local --quiet` · project `myapp-ci` · `abc123def456`')
  assert.match(lines[2], /^> Never started: process \d+ is gone while queued \(interrupted\) · 1m0[56]s\.$/)
})

test('--status with only the last run’s events: an earlier run in the file is not seen', () => {
  const file = eventsFile([
    queuedEvent({ pid: deadPid() }),
    runEvent({ pid: deadPid() }),
    { ts: runEvent().ts, event: 'end', result: 'passed', durationMs: 1000 },
    queuedEvent({ ahead: 1 }),
  ])
  const { status: code, out } = status(['--events', file])
  assert.equal(code, 3)
  assert.match(out, /^> 🚦 ◌ \*\*ci-local\*\* · queued · behind other-ci \(1 ahead\)\n/)
})

test('--status refuses --no-wait, which starts a run', () => {
  const { status: code, err } = status(['--no-wait'], { cwd: project(["ci_step box One 'true'"]) })
  assert.equal(code, 2)
  assert.match(err, /ci-local: --status takes only --events/)
})

test('--status refuses --quiet and --live, which only shape a run', () => {
  for (const option of ['--quiet', '--live']) {
    const { status: code, err } = status([option], { cwd: project(["ci_step box One 'true'"]) })
    assert.equal(code, 2, option)
    assert.match(err, /ci-local: --status takes only --events/, option)
  }
})

test('status.js can be imported from a process whose argv[1] is no file (it is then not the script)', () => {
  const STATUS_JS = fileURLToPath(new URL('../status.js', import.meta.url))
  const code = `import(${JSON.stringify(pathToFileURL(STATUS_JS).href)}).then((m) => console.log(typeof m.render))`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, '/no/such/script'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'function\n')
})

test('--status with CI_LOCAL_EVENTS=off shows no old run: runs write none, so there is none to show', async () => {
  const dir = project(["ci_step box One 'true'"])
  const cache = mkdtempSync(join(tmpdir(), 'c-'))
  await run([], { cwd: dir, cache }) // an old run, in the default file
  const { status: code, out, err } = status([], { cwd: dir, cache, env: { CI_LOCAL_EVENTS: 'off' } })
  assert.equal(code, 2)
  assert.equal(out, '')
  assert.match(err, /ci-local: CI_LOCAL_EVENTS is off: runs record no events, so --status has none to show\n/)
  // An --events file named on the command line is still read.
  const named = status(['--events', join(cache, 'ci-local', 'ci-local-selftest.ndjson')], { cwd: dir, cache, env: { CI_LOCAL_EVENTS: 'off' } })
  assert.equal(named.status, 0, named.stderr)
})

test('BRAND: one emoji names ci-local, before every state mark', async () => {
  const { BRAND, GLYPHS } = await import('../status.js')
  assert.equal(BRAND, '🚦')
  for (const mark of Object.values(GLYPHS)) assert.equal([...mark].length, 1)
})

test('runState: schema is the events contract version of the run, null for events from before it', () => {
  const ts = new Date().toISOString()
  const queued = { ts, event: 'queued', schema: 1, project: 'p', pid: process.pid, ahead: 0, blockedBy: null }
  const opened = { ts, event: 'run', schema: 1, project: 'p', total: 1, pid: process.pid }
  const isAlive = () => true
  assert.equal(runState([queued], { isAlive }).schema, 1, 'waiting: from the queued event')
  assert.equal(runState([queued, opened], { isAlive }).schema, 1, 'running: from the run event')
  const { schema: _q, ...oldQueued } = queued
  const { schema: _r, ...oldRun } = opened
  assert.equal(runState([oldRun], { isAlive }).schema, null, 'before the schema: null')
  assert.equal(runState([oldQueued, oldRun], { isAlive }).schema, null)
})

/** The start time of a live process, read here with its own `ps` call: what a run must record. */
const startOf = (pid) =>
  spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).stdout
    .trim()
    .replace(/\s+/g, ' ')

/** A start time text moved by `seconds`, in the same form (as an NTP step would make `ps` say). */
function shifted(start, seconds) {
  const [, mon, day, time, year] = start.match(/^\w{3} (\w{3}) +(\d+) (\d\d:\d\d:\d\d) (\d{4})$/)
  const at = new Date(Date.parse(`${day} ${mon} ${year} ${time} UTC`) + seconds * 1000)
  const [weekday, , month, , clock] = at.toUTCString().split(' ')
  return `${weekday.slice(0, 3)} ${month} ${at.getUTCDate()} ${clock} ${at.getUTCFullYear()}`
}

test('alive: a start time 2 s off the real one is the same process (the clock was adjusted); 10 s off is another', () => {
  const start = startOf(process.pid)
  for (const seconds of [2, -2, 3, -3]) assert.equal(alive(process.pid, shifted(start, seconds)), true, `${seconds} s`)
  for (const seconds of [10, -10, 4, -4]) assert.equal(alive(process.pid, shifted(start, seconds)), false, `${seconds} s`)
  assert.equal(alive(process.pid, 'not a date'), true, 'a start that is no date cannot tell: the pid decides')
})

test('alive and pidStart: pid 0 and 1 are nobody’s (kill 0 reaches the whole group)', () => {
  assert.equal(alive(0), false)
  assert.equal(alive(1), false)
  assert.equal(alive(0, startOf(process.pid)), false)
  assert.equal(pidStart(0), null)
  assert.equal(pidStart(1), null)
})

test('createPidStartReader: asks ps once per pid within the lifetime, again after it, and never keeps a failure', () => {
  let clock = 1000
  let calls = 0
  let out = { status: 0, stdout: 'Mon Jan  1 00:00:00 2001\n' }
  const read = createPidStartReader({ spawn: () => (calls++, out), now: () => clock, ttl: 5000 })
  assert.equal(read(42), 'Mon Jan 1 00:00:00 2001')
  assert.equal(read(42), 'Mon Jan 1 00:00:00 2001')
  assert.equal(calls, 1)
  assert.equal(read(43), 'Mon Jan 1 00:00:00 2001')
  assert.equal(calls, 2, 'another pid')
  clock += 5001
  read(42)
  assert.equal(calls, 3, 'after the lifetime')
  out = { status: 1, stdout: '' }
  clock += 5001
  assert.equal(read(42), null)
  assert.equal(read(42), null)
  assert.equal(calls, 5, 'a failure is asked again each time')
  out = { status: 0, stdout: 'Tue Jan  2 00:00:00 2001\n' }
  assert.equal(read(42), 'Tue Jan 2 00:00:00 2001')
})

test('pidStart: the start time of a live process, the same for every ci-local (locale and time zone do not change it); none for a gone one', () => {
  const start = startOf(process.pid)
  assert.match(start, /^\w{3} \w{3} \d{1,2} \d\d:\d\d:\d\d \d{4}$/)
  assert.equal(pidStart(process.pid), start)
  assert.equal(pidStart(deadPid()), null)
  assert.equal(pidStart(null), null)
})

test('alive: a pid counts as gone when its recorded start time differs, and as before when there is none', () => {
  const start = startOf(process.pid)
  assert.equal(alive(process.pid, start), true)
  assert.equal(alive(process.pid, 'Mon Jan  1 00:00:00 2001'), false, 'the pid was given to another process')
  assert.equal(alive(process.pid), true, 'an event without a start time: the pid alone')
  assert.equal(alive(process.pid, null), true)
  assert.equal(alive(deadPid(), start), false)
})

for (const [name, make] of [
  ['run', (fields) => [runEvent(fields)]],
  ['queued', (fields) => [queuedEvent(fields)]],
]) {
  test(`--status on a ${name} event whose pid lives but started at another time: stopped, status 4`, () => {
    const { status: code, out } = status(['--events', eventsFile(make({ pidStart: 'Mon Jan  1 00:00:00 2001' }))])
    assert.equal(code, 4)
    assert.match(out, /^> 🚦 ⊘ \*\*ci-local\*\* · stopped\n/)
  })

  test(`--status on a ${name} event whose pid lives and started at the recorded time: still going, status 3`, () => {
    const { status: code, out } = status(['--events', eventsFile(make({ pidStart: startOf(process.pid) }))])
    assert.equal(code, 3)
    assert.doesNotMatch(out, /stopped/)
  })

  test(`--status on a ${name} event with no start time (an older run): the pid alone decides`, () => {
    const { status: code } = status(['--events', eventsFile(make({}))])
    assert.equal(code, 3)
  })
}
