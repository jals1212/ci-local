// The machine-wide queue: only one run at a time uses Docker. Runs use
// test/fixture/fake-docker (no daemon); two runs of two projects are two
// ci-local processes sharing a queue directory. Synchronisation is by files
// the steps touch and the tests poll for, never by a fixed sleep.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// The user's settings (~/.ci-local/config.json, a CI_LOCAL_MAX_RUNS in the
// shell) must not change what these runs do: a test that wants them sets them.
process.env.CI_LOCAL_USER_CONFIG = 'off'
delete process.env.CI_LOCAL_MAX_RUNS

const BIN = fileURLToPath(new URL('../bin/ci-local', import.meta.url))
const FAKE_DOCKER = fileURLToPath(new URL('./fixture/fake-docker/', import.meta.url))
chmodSync(join(FAKE_DOCKER, 'docker'), 0o755)

// Root ignores directory permissions: tests that rely on them cannot run as root.
const asRoot = process.getuid?.() === 0 && 'root ignores directory permissions'

const scratch = (prefix = 'q-') => mkdtempSync(join(tmpdir(), `ci-local-${prefix}`))

/** A project directory named `name` with this plan (the body of ci_plan). */
function project(name, plan) {
  const dir = scratch('proj-')
  writeFileSync(join(dir, '.nvmrc'), '24.21.0\n')
  writeFileSync(
    join(dir, 'ci-local.config.sh'),
    [`CI_PROJECT=${name}`, 'CI_JOBS=(a)', 'ci_plan() {', ...plan.map((line) => `  ${line}`), '}', ''].join('\n')
  )
  return dir
}

// A step that says it started (`started`) and holds the machine until the
// test writes `release` in the project directory (it gives up after 20s).
const GATE =
  "ci_step box Gate 'touch started; i=0; while [ ! -f release ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done; [ -f release ]'"
const WORK = "ci_step box Work 'touch ran'"

const children = []
after(() => children.forEach((child) => child.kill('SIGKILL')))

/** A run in flight: its output so far, and `done` for its end. */
function start(args, { cwd, queue, env = {} }) {
  const base = { ...process.env }
  for (const name of ['CI_LOCAL_QUIET', 'CI_LOCAL_EVENTS', 'CI_LOCAL_QUEUE', 'CI_LOCAL_QUEUE_DIR', 'CI_LOCAL_QUEUE_POLL', 'CI_LOCAL_MAX_RUNS'])
    delete base[name]
  const child = spawn('bash', [BIN, ...args], {
    cwd,
    env: {
      ...base,
      XDG_CACHE_HOME: scratch('cache-'),
      CI_LOCAL_QUEUE_DIR: queue,
      CI_LOCAL_QUEUE_POLL: '0.1',
      PATH: `${FAKE_DOCKER}:${process.env.PATH}`,
      ...env,
    },
  })
  children.push(child)
  const run = { child, out: '', err: '' }
  child.stdout.on('data', (chunk) => (run.out += chunk))
  child.stderr.on('data', (chunk) => (run.err += chunk))
  run.done = new Promise((resolve) => child.on('close', (status) => resolve({ status, out: run.out, err: run.err })))
  return run
}

/** Resolves when check() is true; fails after timeoutMs. */
async function until(check, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`still waiting after ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const events = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)]
          } catch {
            return []
          }
        })
    : []
const kinds = (file, kind) => events(file).filter((event) => event.event === kind)
const at = (file, kind) => Date.parse(kinds(file, kind)[0].ts)
const eventsOf = () => join(scratch('ev-'), 'events.ndjson')

const TICKET = /^\d{15}-\d{10}$/
const tickets = (queue) => (existsSync(queue) ? readdirSync(queue).filter((name) => TICKET.test(name)).sort() : [])
const waitingLines = (out) => out.split('\n').filter((line) => line.startsWith('Waiting for '))
const release = (dir) => writeFileSync(join(dir, 'release'), '')

/** A pid that no process has. */
function deadPid() {
  return Number(spawnSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim())
}
const pad = (n, width) => String(n).padStart(width, '0')

/** The start time of a live process, from a `ps` call of its own: what a run must record next to its pid. */
const startOf = (pid) =>
  spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).stdout
    .trim()
    .replace(/\s+/g, ' ')
// A start time no process has: the pid it goes with was given to another process.
const WRONG_START = 'Mon Jan 1 00:00:00 2001'

/** A start time text moved by `seconds`, in the same form (as an NTP step would make `ps` say). */
function shifted(start, seconds) {
  const [, mon, day, time, year] = start.match(/^\w{3} (\w{3}) +(\d+) (\d\d:\d\d:\d\d) (\d{4})$/)
  const at = new Date(Date.parse(`${day} ${mon} ${year} ${time} UTC`) + seconds * 1000)
  const [weekday, , month, , clock] = at.toUTCString().split(' ')
  return `${weekday.slice(0, 3)} ${month} ${at.getUTCDate()} ${clock} ${at.getUTCFullYear()}`
}

/** A ticket as a run would have left it. */
function plantTicket(queue, pid, { ms = 1, name = 'ghost', pidStart } = {}) {
  mkdirSync(queue, { recursive: true })
  const start = pidStart === undefined ? '' : `pidStart=${pidStart}\n`
  writeFileSync(join(queue, `${pad(ms, 15)}-${pad(pid, 10)}`), `project=${name}\npid=${pid}\n${start}repo=/nowhere\n`)
}

function plantLock(queue, { pid, project: name, pidStart } = {}) {
  mkdirSync(join(queue, 'lock'), { recursive: true })
  if (name) writeFileSync(join(queue, 'lock', 'project'), name)
  if (pid !== undefined) writeFileSync(join(queue, 'lock', 'pid'), pidStart === undefined ? String(pid) : `${pid}\n${pidStart}\n`)
}

test('two runs: the second waits for the first’s end, says whom it waits for, and records it', async () => {
  const queue = scratch()
  const dirA = project('proj-a', [GATE])
  const dirB = project('proj-b', [WORK])
  const evA = eventsOf()
  const evB = eventsOf()
  const runA = start(['--events', evA], { cwd: dirA, queue })
  let runB
  try {
    await until(() => existsSync(join(dirA, 'started')))
    const pidA = kinds(evA, 'run')[0].pid
    // The first run's ticket and lock say who holds the machine.
    const [ticket] = tickets(queue)
    assert.equal(tickets(queue).length, 1)
    assert.equal(ticket.slice(-10), pad(pidA, 10))
    // The start time goes next to the pid, so a pid given to another process later is told from the run.
    const startA = startOf(pidA)
    assert.match(startA, /^\w{3} \w{3} \d{1,2} \d\d:\d\d:\d\d \d{4}$/)
    assert.equal(readFileSync(join(queue, ticket), 'utf8'), `project=proj-a\npid=${pidA}\npidStart=${startA}\nrepo=${realpathSync(dirA)}\n`)
    // lock/pid: the pid first, as older versions read it, then the start time.
    assert.equal(readFileSync(join(queue, 'lock', 'pid'), 'utf8'), `${pidA}\n${startA}\n`)
    assert.equal(kinds(evA, 'queued')[0].pidStart, startA)
    assert.equal(kinds(evA, 'run')[0].pidStart, startA)

    runB = start(['--events', evB], { cwd: dirB, queue })
    await until(() => runB.out.includes('Waiting for '))
    // Polled a few times meanwhile: the line is not repeated, nothing ran.
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.deepEqual(waitingLines(runB.out), [`Waiting for proj-a (pid ${pidA}) · 1 ahead`])
    assert.equal(existsSync(join(dirB, 'ran')), false)
    assert.deepEqual(kinds(evB, 'run'), [])
    assert.equal(tickets(queue).length, 2)

    release(dirA)
    // Order by cause, not by clock: A writes its end before it gives the turn
    // up, and B's run event comes after it got the turn, so when B's run is
    // there A's end must be. (Timestamps of two processes are not a safe
    // order: each is truncated to its own millisecond, and a clock may step.)
    await until(() => kinds(evB, 'run').length > 0)
    assert.equal(kinds(evA, 'end').length, 1, 'A’s end is written before B’s run begins')
    const [a, b] = await Promise.all([runA.done, runB.done])
    assert.equal(a.status, 0, a.err)
    assert.equal(b.status, 0, b.err)
    assert.match(b.out, /\nQueue: your turn after \d+s\n/)
    assert.doesNotMatch(a.out, /Waiting for |Queue: your turn/)
    assert.ok(b.out.indexOf('Queue: your turn') < b.out.search(/ci-local \d+\.\d+\.\d+: 1 steps/), 'before the banner')
    // queued: what B saw when it queued, and that it then got its turn.
    assert.deepEqual(
      kinds(evB, 'queued').map((event) => [event.ahead, event.blockedBy]),
      [
        [1, { project: 'proj-a', pid: pidA }],
        [0, null],
      ]
    )
    const [first] = kinds(evB, 'queued')
    assert.equal(first.project, 'proj-b')
    assert.equal(first.pid, kinds(evB, 'run')[0].pid)
    assert.deepEqual(first.args, ['--events', evB])
    assert.deepEqual(
      events(evB).map((event) => event.event),
      ['queued', 'queued', 'run', 'start', 'ok', 'end']
    )
    // Nothing of either run is left in the queue.
    assert.deepEqual(readdirSync(queue), [])
  } catch (error) {
    // Seen failing once in about 40 runs and never reproduced: say everything.
    // (See issue #7: paste this output there if it fails again.)
    const dump = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '(none)')
    error.message += `\n--- A out:\n${runA.out}\n--- A err:\n${runA.err}\n--- A events:\n${dump(evA)}`
    error.message += `\n--- B out:\n${runB?.out}\n--- B err:\n${runB?.err}\n--- B events:\n${dump(evB)}`
    error.message += `\n--- queue: ${existsSync(queue) ? readdirSync(queue).join(' ') : '(none)'}`
    throw error
  }
})

test('a third run keeps its place: A, then B, then C; it re-announces whom it waits for', async () => {
  const queue = scratch()
  const dirA = project('proj-a', [GATE])
  const dirB = project('proj-b', [GATE])
  const dirC = project('proj-c', [WORK])
  const evA = eventsOf()
  const evB = eventsOf()
  const evC = eventsOf()
  const runA = start(['--events', evA], { cwd: dirA, queue })
  await until(() => existsSync(join(dirA, 'started')))
  const runB = start(['--events', evB], { cwd: dirB, queue })
  await until(() => kinds(evB, 'queued').length > 0)
  const runC = start(['--events', evC], { cwd: dirC, queue })
  await until(() => runC.out.includes('Waiting for '))
  const pidA = kinds(evA, 'run')[0].pid

  release(dirA)
  await until(() => existsSync(join(dirB, 'started')))
  const pidB = kinds(evB, 'run')[0].pid
  await until(() => waitingLines(runC.out).length === 2)
  assert.equal(existsSync(join(dirC, 'ran')), false, 'C waits for B, which came first')
  release(dirB)
  const results = await Promise.all([runA.done, runB.done, runC.done])
  for (const result of results) assert.equal(result.status, 0, result.err)

  assert.deepEqual(waitingLines(results[2].out), [
    `Waiting for proj-a (pid ${pidA}) · 2 ahead`,
    `Waiting for proj-b (pid ${pidB}) · 1 ahead`,
  ])
  assert.deepEqual(
    kinds(evC, 'queued').map((event) => [event.ahead, event.blockedBy?.project ?? null]),
    [
      [2, 'proj-a'],
      [1, 'proj-b'],
      [0, null],
    ]
  )
  assert.ok(at(evB, 'run') >= at(evA, 'end'))
  assert.ok(at(evC, 'run') >= at(evB, 'end'))
})

test('a ticket of a dead process, and a lock of one, are ignored: the run goes ahead', async () => {
  const queue = scratch()
  const dead = deadPid()
  plantTicket(queue, dead, { ms: 1 })
  plantLock(queue, { pid: dead, project: 'ghost' })
  const dir = project('proj-a', [WORK])
  const started = Date.now()
  const { status, out, err } = await start([], { cwd: dir, queue }).done
  assert.equal(status, 0, err)
  assert.ok(Date.now() - started < 10_000, 'not stuck behind the dead')
  assert.doesNotMatch(out, /Waiting for|Queue: your turn/)
  assert.equal(existsSync(join(dir, 'ran')), true)
  assert.deepEqual(readdirSync(queue), [], 'the dead ticket and lock are gone, and so are the run’s own')
})

test('a lock with no pid is stale after 10 seconds, and held before', async () => {
  const dir = project('proj-a', [WORK])
  const young = scratch()
  plantLock(young)
  const busy = await start(['--no-wait'], { cwd: dir, queue: young }).done
  assert.equal(busy.status, 3, 'a lock just made may be about to get its pid')
  assert.equal(busy.err, 'ci-local: the machine is busy: unknown (pid ?)\n')
  assert.equal(existsSync(join(young, 'lock')), true)

  const old = scratch()
  plantLock(old)
  const longAgo = new Date(Date.now() - 20_000)
  utimesSync(join(old, 'lock'), longAgo, longAgo)
  const { status, err } = await start([], { cwd: dir, queue: old }).done
  assert.equal(status, 0, err)
  assert.deepEqual(readdirSync(old), [])
})

test('--no-wait on a machine held by a live process: status 3, the lock stays, no ticket is left', async () => {
  const queue = scratch()
  plantLock(queue, { pid: process.pid, project: 'holder' })
  const dir = project('proj-a', [WORK])
  const { status, out, err } = await start(['--no-wait'], { cwd: dir, queue }).done
  assert.equal(status, 3)
  assert.equal(err, `ci-local: the machine is busy: holder (pid ${process.pid})\n`)
  assert.equal(out, '')
  assert.equal(existsSync(join(dir, 'ran')), false)
  assert.deepEqual(tickets(queue), [])
  assert.equal(readFileSync(join(queue, 'lock', 'pid'), 'utf8'), String(process.pid), 'a live lock is never removed')
})

test('--no-wait behind a running run: status 3 naming it; the run itself is not disturbed', async () => {
  const queue = scratch()
  const dirA = project('proj-a', [GATE])
  const dirB = project('proj-b', [WORK])
  const evA = eventsOf()
  const evB = eventsOf()
  // B's last run, which a refused --no-wait must leave for --status.
  const previous = '{"ts":"2026-01-01T00:00:00.000Z","event":"run","project":"proj-b","pid":1}\n{"ts":"2026-01-01T00:00:01.000Z","event":"end","result":"passed","durationMs":1000}\n'
  writeFileSync(evB, previous)
  const runA = start(['--events', evA], { cwd: dirA, queue })
  await until(() => existsSync(join(dirA, 'started')))
  const pidA = kinds(evA, 'run')[0].pid
  const before = tickets(queue)
  const b = await start(['--no-wait', '--events', evB], { cwd: dirB, queue }).done
  assert.equal(b.status, 3)
  assert.equal(b.err, `ci-local: the machine is busy: proj-a (pid ${pidA})\n`)
  assert.doesNotMatch(b.out, /Waiting for/)
  assert.equal(existsSync(join(dirB, 'ran')), false)
  assert.deepEqual(tickets(queue), before, 'B’s ticket is gone')
  assert.equal(readFileSync(evB, 'utf8'), previous, 'a refused run leaves the events file alone')
  release(dirA)
  assert.equal((await runA.done).status, 0)
})

test('--no-wait on a free machine just runs', async () => {
  const queue = scratch()
  const dir = project('proj-a', [WORK])
  const { status, out, err } = await start(['--no-wait'], { cwd: dir, queue }).done
  assert.equal(status, 0, err)
  assert.doesNotMatch(out, /Waiting for|Queue: your turn/)
  assert.equal(existsSync(join(dir, 'ran')), true)
})

for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  test(`${signal} while waiting: status ${code}, the ticket is removed, no teardown, the holder is undisturbed`, async () => {
    const queue = scratch()
    // The same project: a teardown by the waiter would remove the holder's runner.
    const dirA = project('proj-shared', [GATE])
    const dirB = project('proj-shared', [GATE])
    const evA = eventsOf()
    const evB = eventsOf()
    const pids = join(scratch('pids-'), 'pids')
    const env = { FAKE_DOCKER_PIDS: pids }
    const runA = start(['--events', evA], { cwd: dirA, queue, env })
    await until(() => existsSync(join(dirA, 'started')) && existsSync(pids))
    const runB = start(['--events', evB], { cwd: dirB, queue, env })
    await until(() => runB.out.includes('Waiting for '))
    assert.equal(tickets(queue).length, 2)

    runB.child.kill(signal)
    const b = await runB.done
    assert.equal(b.status, code)
    assert.doesNotMatch(b.out + b.err, /Removing project|ci-local summary|FAILED|PASSED/)
    assert.equal(existsSync(join(dirB, 'started')), false)
    assert.equal(tickets(queue).length, 1, 'only the holder’s ticket is left')
    assert.equal(readFileSync(join(queue, 'lock', 'pid'), 'utf8').split('\n')[0], String(kinds(evA, 'run')[0].pid))
    assert.deepEqual(
      events(evB).map((event) => event.event),
      ['queued'],
      'B never started'
    )

    release(dirA)
    const a = await runA.done
    assert.equal(a.status, 0, a.err)
    assert.equal(kinds(evA, 'fail').length, 0, 'A’s step was not killed by a teardown')
    assert.equal(kinds(evA, 'end')[0].result, 'passed')
    assert.deepEqual(readdirSync(queue), [])
  })
}

test('CI_LOCAL_QUEUE=off: runs go side by side, touch no queue, and still say they are queued', async () => {
  const queue = join(scratch(), 'never-made')
  // Each step passes only when the other run's step has started.
  const dirA = project('proj-a', [])
  const dirB = project('proj-b', [])
  const meet = (other) =>
    `ci_step box Meet 'touch started; for i in $(seq 1 200); do [ -f ${other}/started ] && exit 0; sleep 0.05; done; exit 1'`
  writeFileSync(
    join(dirA, 'ci-local.config.sh'),
    `CI_PROJECT=proj-a\nCI_JOBS=(a)\nci_plan() {\n  ${meet(dirB)}\n}\n`
  )
  writeFileSync(
    join(dirB, 'ci-local.config.sh'),
    `CI_PROJECT=proj-b\nCI_JOBS=(a)\nci_plan() {\n  ${meet(dirA)}\n}\n`
  )
  const evA = eventsOf()
  const evB = eventsOf()
  const env = { CI_LOCAL_QUEUE: 'off' }
  const results = await Promise.all([
    start(['--events', evA], { cwd: dirA, queue, env }).done,
    start(['--events', evB], { cwd: dirB, queue, env }).done,
  ])
  for (const result of results) {
    assert.equal(result.status, 0, result.err)
    assert.doesNotMatch(result.out, /Waiting for|Queue: your turn/)
  }
  assert.equal(existsSync(queue), false)
  for (const file of [evA, evB]) {
    assert.deepEqual(
      kinds(file, 'queued').map((event) => [event.ahead, event.blockedBy]),
      [[0, null]]
    )
    assert.deepEqual(
      events(file).map((event) => event.event),
      ['queued', 'run', 'start', 'ok', 'end']
    )
  }
})

test('CI_LOCAL_QUEUE: 0, false and no turn it off too; anything else leaves it on', async () => {
  for (const value of ['0', 'false', 'no', 'off']) {
    const queue = join(scratch(), 'never-made')
    const { status, err } = await start([], { cwd: project('proj-a', [WORK]), queue, env: { CI_LOCAL_QUEUE: value } }).done
    assert.equal(status, 0, err)
    assert.equal(existsSync(queue), false, value)
  }
  const queue = join(scratch(), 'made')
  const { status, err } = await start([], { cwd: project('proj-a', [WORK]), queue, env: { CI_LOCAL_QUEUE: 'on' } }).done
  assert.equal(status, 0, err)
  assert.equal(existsSync(queue), true)
})

test('--status on a run that waits its turn: the queued block, status 3', async () => {
  const queue = scratch()
  const dirA = project('proj-a', [GATE])
  const dirB = project('proj-b', [WORK])
  const evA = eventsOf()
  const evB = eventsOf()
  const runA = start(['--events', evA], { cwd: dirA, queue })
  await until(() => existsSync(join(dirA, 'started')))
  const runB = start(['--events', evB], { cwd: dirB, queue })
  await until(() => runB.out.includes('Waiting for '))
  const shown = spawnSync('bash', [BIN, '--status', '--events', evB], { encoding: 'utf8', env: { ...process.env, PATH: process.env.PATH } })
  assert.equal(shown.status, 3)
  const lines = shown.stdout.trimEnd().split('\n')
  assert.equal(lines[0], '> 🚦 ◌ **ci-local** · queued · behind proj-a (1 ahead)')
  assert.match(lines[1], new RegExp(`^> \`ci-local --events ${evB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\` · project \`proj-b\` · not a git checkout · waiting \\d+s$`))
  assert.equal(lines[2], `> Follow it: \`tail -f ${evB}\``)
  release(dirA)
  await Promise.all([runA.done, runB.done])
  const after = spawnSync('bash', [BIN, '--status', '--events', evB], { encoding: 'utf8' })
  assert.equal(after.status, 0)
  assert.match(after.stdout, /^> 🚦 ✓ \*\*ci-local\*\* · passed\n/)
})

test('the queue and the events go to the cache of the user; its directories are private', async () => {
  const cache = scratch('cache-')
  const dir = project('proj-a', [WORK])
  const run = start([], { cwd: dir, queue: undefined, env: { XDG_CACHE_HOME: cache, CI_LOCAL_QUEUE_DIR: undefined } })
  const { status, err } = await run.done
  assert.equal(status, 0, err)
  assert.equal(statSync(join(cache, 'ci-local')).mode & 0o777, 0o700)
  assert.equal(statSync(join(cache, 'ci-local', 'queue')).mode & 0o777, 0o700)
  assert.equal(existsSync(join(cache, 'ci-local', 'proj-a.ndjson')), true)
  assert.deepEqual(readdirSync(join(cache, 'ci-local', 'queue')), [])
})

test('with neither HOME nor XDG_CACHE_HOME: a run and --status use a directory under TMPDIR', async () => {
  const tmp = scratch('tmpdir-')
  const dir = project('proj-a', [WORK])
  const env = { HOME: undefined, XDG_CACHE_HOME: undefined, CI_LOCAL_QUEUE_DIR: undefined, TMPDIR: tmp }
  const { status, out, err } = await start([], { cwd: dir, queue: undefined, env }).done
  assert.equal(status, 0, err)
  const root = join(tmp, `ci-local-${process.getuid()}`)
  assert.match(out, new RegExp(`\\nEvents: ${join(root, 'ci-local', 'proj-a.ndjson').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `))
  assert.equal(statSync(root).mode & 0o777, 0o700)
  assert.equal(statSync(join(root, 'ci-local')).mode & 0o777, 0o700)
  assert.equal(existsSync(join(root, 'ci-local', 'queue')), true)
  assert.equal(existsSync(join(dir, 'ran')), true)

  const base = { ...process.env, TMPDIR: tmp, PATH: `${FAKE_DOCKER}:${process.env.PATH}` }
  delete base.HOME
  delete base.XDG_CACHE_HOME
  delete base.CI_LOCAL_EVENTS
  delete base.PI_SESSION_ID
  const shown = spawnSync('bash', [BIN, '--status'], { cwd: dir, encoding: 'utf8', env: base })
  assert.equal(shown.status, 0, shown.stderr)
  assert.match(shown.stdout, /^> 🚦 ✓ \*\*ci-local\*\* · passed\n/)
})

test('--list, --print-plan, --down, --status, --help and --version make no queue', async () => {
  const queue = join(scratch(), 'never-made')
  const dir = project('proj-a', [WORK])
  for (const args of [['--list'], ['--print-plan'], ['--down'], ['--status', '--events', join(dir, 'none')], ['--help'], ['--version']]) {
    const { status } = await start(args, { cwd: dir, queue }).done
    assert.ok(status === 0 || status === 2, args.join(' '))
    assert.equal(existsSync(queue), false, args.join(' '))
  }
  assert.equal(existsSync(join(dir, 'ran')), false)
})

test('a queue directory that cannot be made is a warning: the run goes on without waiting', async () => {
  const blocker = join(scratch(), 'a-file')
  writeFileSync(blocker, 'not a directory')
  const dir = project('proj-a', [WORK])
  const { status, err } = await start([], { cwd: dir, queue: join(blocker, 'queue') }).done
  assert.equal(status, 0, err)
  assert.match(err, /ci-local: cannot use the queue directory .*: running without waiting\n/)
  assert.equal(existsSync(join(dir, 'ran')), true)
})

/** The events in a project's default events file under `cache`. */
const defaultEvents = (cache, name) =>
  readFileSync(join(cache, 'ci-local', `${name}.ndjson`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))

/** The pids of the runs that wrote these events (only queued and run carry one). */
const writers = (events) => [...new Set(events.filter((event) => 'pid' in event).map((event) => event.pid))]

const statusIn = (cache, cwd) =>
  spawnSync('bash', [BIN, '--status'], { cwd, encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: cache } })

test('a second run of the same project does not take over the events file of the one in flight', async () => {
  const queue = scratch('queue-')
  const cache = scratch('cache-')
  const dirA = project('same-ci', [GATE])
  const dirB = project('same-ci', [WORK])
  const a = start([], { cwd: dirA, queue, env: { XDG_CACHE_HOME: cache } })
  await until(() => existsSync(join(dirA, 'started')))
  const b = start([], { cwd: dirB, queue, env: { XDG_CACHE_HOME: cache } })
  await until(() => b.out.includes('Waiting for same-ci'))

  // While B waits, the file is still A's alone, and --status shows A running.
  const during = defaultEvents(cache, 'same-ci')
  assert.deepEqual(writers(during), [a.child.pid])
  assert.ok(during.some((event) => event.event === 'run'))
  const shown = statusIn(cache, dirA)
  assert.equal(shown.status, 3, shown.stdout + shown.stderr)
  assert.match(shown.stdout, /running · \[1\/1\] Gate/)

  writeFileSync(join(dirA, 'release'), '')
  assert.equal((await a.done).status, 0)
  assert.equal((await b.done).status, 0)
  // Once B had its turn, the file is B's alone, from its first event to its end.
  const after = defaultEvents(cache, 'same-ci')
  assert.deepEqual(writers(after), [b.child.pid])
  assert.equal(after[0].event, 'queued')
  assert.equal(after.at(-1).event, 'end')
  assert.equal(after.at(-1).result, 'passed')
})

test('CI_LOCAL_QUEUE=off: a second run of the same project leaves the live events file alone, and says so', async () => {
  const queue = scratch('queue-')
  const cache = scratch('cache-')
  const dirA = project('same-ci', [GATE])
  const dirB = project('same-ci', [WORK])
  const env = { XDG_CACHE_HOME: cache, CI_LOCAL_QUEUE: 'off' }
  const a = start([], { cwd: dirA, queue, env })
  await until(() => existsSync(join(dirA, 'started')))
  const b = start([], { cwd: dirB, queue, env })
  const doneB = await b.done
  assert.equal(doneB.status, 0, doneB.err)
  assert.match(doneB.err, new RegExp(`ci-local: the events file .* belongs to run ${a.child.pid}, still going: this run writes no events\\n`))
  writeFileSync(join(dirA, 'release'), '')
  assert.equal((await a.done).status, 0)
  const events = defaultEvents(cache, 'same-ci')
  assert.deepEqual(writers(events), [a.child.pid])
  assert.equal(events.at(-1).result, 'passed')
})

test('the TMPDIR fallback is refused when it is not a private directory of this user: no events, no queue', async () => {
  const fallback = (tmp) => join(tmp, `ci-local-${process.getuid()}`)
  const env = (tmp) => ({ HOME: undefined, XDG_CACHE_HOME: undefined, CI_LOCAL_QUEUE_DIR: undefined, TMPDIR: tmp })

  // Someone else's directory, planted as a symlink at the fallback path.
  const symTmp = scratch('tmpdir-')
  const planted = scratch('planted-')
  symlinkSync(planted, fallback(symTmp))
  // A directory any user can write.
  const openTmp = scratch('tmpdir-')
  mkdirSync(fallback(openTmp))
  chmodSync(fallback(openTmp), 0o777)

  for (const [tmp, inside] of [
    [symTmp, planted],
    [openTmp, fallback(openTmp)],
  ]) {
    const dir = project('proj-a', [WORK])
    const { status, out, err } = await start([], { cwd: dir, queue: undefined, env: env(tmp) }).done
    assert.equal(status, 0, err)
    assert.match(err, /ci-local: .*ci-local-\d+ is not a private directory of this user: no events file, no queue\n/)
    assert.doesNotMatch(out, /\nEvents: /)
    assert.deepEqual(readdirSync(inside), [], 'nothing written there')
    assert.equal(existsSync(join(dir, 'ran')), true, 'the run itself goes on')
  }
})

test('a run claims the events file under <file>.claim: it waits for a held claim, then takes the file', async () => {
  const queue = scratch('queue-')
  const cache = scratch('cache-')
  const dir = project('claim-ci', [WORK])
  const file = join(cache, 'ci-local', 'claim-ci.ndjson')
  mkdirSync(join(cache, 'ci-local'), { recursive: true })
  writeFileSync(file, '{"left":"by whoever holds the claim"}\n')
  mkdirSync(`${file}.claim`) // held, fresh: another run between its check and its first event

  const run = start([], { cwd: dir, queue, env: { XDG_CACHE_HOME: cache } })
  // The queue lock is taken just before the first queued event, which is
  // when the run claims the file: from here it can only be waiting.
  await until(() => existsSync(join(queue, 'lock', 'pid')))
  assert.equal(readFileSync(file, 'utf8'), '{"left":"by whoever holds the claim"}\n', 'untouched while claimed')
  assert.equal(existsSync(join(dir, 'ran')), false)

  const released = Date.now()
  rmSync(`${file}.claim`, { recursive: true })
  const { status, err } = await run.done
  assert.equal(status, 0, err)
  const events = defaultEvents(cache, 'claim-ci')
  assert.equal(events[0].event, 'queued')
  assert.equal(events[0].pid, run.child.pid)
  assert.ok(Date.parse(events[0].ts) >= released - 5, 'its first event came after the claim was given back')
  assert.equal(existsSync(`${file}.claim`), false, 'the claim is given back')
})

test('a claim left by a dead run (older than 10 seconds) is broken', async () => {
  const cache = scratch('cache-')
  const dir = project('claim-ci', [WORK])
  const file = join(cache, 'ci-local', 'claim-ci.ndjson')
  mkdirSync(`${file}.claim`, { recursive: true })
  const old = new Date(Date.now() - 60_000)
  utimesSync(`${file}.claim`, old, old)
  const started = Date.now()
  const { status, err } = await start([], { cwd: dir, queue: scratch('queue-'), env: { XDG_CACHE_HOME: cache } }).done
  assert.equal(status, 0, err)
  assert.ok(Date.now() - started < 5000, 'promptly')
  assert.equal(defaultEvents(cache, 'claim-ci').at(-1).result, 'passed')
})

test('an events file whose directory takes no .claim: the run writes it without a claim, as before 0.4.0', { skip: asRoot }, async () => {
  const dir = project('claim-ci', [WORK])
  const locked = scratch('locked-')
  const file = join(locked, 'events.ndjson')
  writeFileSync(file, '')
  chmodSync(locked, 0o555) // the file stays writable; nothing can be made beside it
  try {
    const started = Date.now()
    const { status, err } = await start(['--events', file], { cwd: dir, queue: scratch('queue-') }).done
    assert.equal(status, 0, err)
    assert.ok(Date.now() - started < 4000, `took ${Date.now() - started}ms: no 10-second wait for a claim that cannot be made`)
    const events = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(events[0].event, 'queued')
    assert.equal(events.at(-1).result, 'passed')
    assert.equal(existsSync(join(dir, 'ran')), true)
  } finally {
    chmodSync(locked, 0o755)
  }
})

test('a stale claim that cannot be removed does not spin: the run gives it up at once', { skip: asRoot }, async () => {
  const dir = project('claim-ci', [WORK])
  const locked = scratch('locked-')
  const file = join(locked, 'events.ndjson')
  writeFileSync(file, '')
  mkdirSync(`${file}.claim`)
  const old = new Date(Date.now() - 60_000)
  utimesSync(`${file}.claim`, old, old)
  chmodSync(locked, 0o555) // the stale claim can be neither moved nor removed
  try {
    const started = Date.now()
    const { status, err } = await start(['--events', file], { cwd: dir, queue: scratch('queue-') }).done
    assert.equal(status, 0, err)
    assert.ok(Date.now() - started < 4000, `took ${Date.now() - started}ms`)
    assert.match(err, /ci-local: cannot claim the events file .*events\.ndjson: this run writes no events\n/)
    assert.equal(existsSync(join(dir, 'ran')), true)
  } finally {
    chmodSync(locked, 0o755)
  }
})

test('in the TMPDIR fallback, a ci-local directory inside that others can write is refused too', async () => {
  const tmp = scratch('tmpdir-')
  const base = join(tmp, `ci-local-${process.getuid()}`)
  mkdirSync(join(base, 'ci-local'), { recursive: true })
  chmodSync(base, 0o700)
  chmodSync(join(base, 'ci-local'), 0o777)
  const dir = project('proj-a', [WORK])
  const env = { HOME: undefined, XDG_CACHE_HOME: undefined, CI_LOCAL_QUEUE_DIR: undefined, TMPDIR: tmp }
  const { status, out, err } = await start([], { cwd: dir, queue: undefined, env }).done
  assert.equal(status, 0, err)
  assert.doesNotMatch(out, /\nEvents: /)
  assert.deepEqual(readdirSync(join(base, 'ci-local')), [], 'nothing written there')
  assert.equal(existsSync(join(dir, 'ran')), true)
})

test('CI_LOCAL_QUEUE_POLL of 0 (or anything not above 0) falls back to 2 seconds: no busy loop while waiting', async () => {
  for (const poll of ['0', '0.0']) {
    const queue = scratch('queue-')
    const dirA = project('proj-a', [GATE])
    const dirB = project('proj-b', [WORK])
    const a = start([], { cwd: dirA, queue })
    await until(() => existsSync(join(dirA, 'started')))
    // B under a shell that reports, with `times`, the CPU its children used:
    // the waiting run and every process it starts.
    const base = { ...process.env, XDG_CACHE_HOME: scratch('cache-'), CI_LOCAL_QUEUE_DIR: queue, CI_LOCAL_QUEUE_POLL: poll, PATH: `${FAKE_DOCKER}:${process.env.PATH}` }
    const b = spawn('bash', ['-c', 'bash "$0"; times', BIN], { cwd: dirB, env: base })
    children.push(b)
    let out = ''
    b.stdout.on('data', (chunk) => (out += chunk))
    const doneB = new Promise((resolve) => b.on('close', resolve))
    await until(() => out.includes('Waiting for '))
    await new Promise((resolve) => setTimeout(resolve, 1500))
    release(dirA)
    assert.equal((await a.done).status, 0)
    await doneB
    const seconds = (text) => text.split(/\s+/).reduce((sum, t) => sum + Number(t.replace(/^(\d+)m([\d.]+)s$/, (_, m, sec) => String(Number(m) * 60 + Number(sec)))), 0)
    const childrenCpu = seconds(out.trim().split('\n').at(-1))
    assert.ok(childrenCpu < 1, `CI_LOCAL_QUEUE_POLL=${poll}: the waiting run used ${childrenCpu}s of CPU (a busy loop)`)
  }
})

// ------------------------------------------------ a pid given to another process (#3)

test('a ticket whose pid lives but started at another time is a dead run’s: ignored and removed', async () => {
  const queue = scratch()
  plantTicket(queue, process.pid, { ms: 1, pidStart: WRONG_START })
  const dir = project('proj-a', [WORK])
  const { status, out, err } = await start([], { cwd: dir, queue }).done
  assert.equal(status, 0, err)
  assert.doesNotMatch(out, /Waiting for|Queue: your turn/)
  assert.equal(existsSync(join(dir, 'ran')), true)
  assert.deepEqual(readdirSync(queue), [])
})

test('a ticket whose pid lives and started at the recorded time is ahead: --no-wait is refused, naming it', async () => {
  const queue = scratch()
  plantTicket(queue, process.pid, { ms: 1, pidStart: startOf(process.pid) })
  const dir = project('proj-a', [WORK])
  const { status, err } = await start(['--no-wait'], { cwd: dir, queue }).done
  assert.equal(status, 3)
  assert.equal(err, `ci-local: the machine is busy: ghost (pid ${process.pid})\n`)
  assert.equal(existsSync(join(dir, 'ran')), false)
})

test('a lock whose pid lives but started at another time is a dead run’s: taken over', async () => {
  const queue = scratch()
  plantLock(queue, { pid: process.pid, project: 'ghost', pidStart: WRONG_START })
  const dir = project('proj-a', [WORK])
  const { status, out, err } = await start([], { cwd: dir, queue }).done
  assert.equal(status, 0, err)
  assert.doesNotMatch(out, /Waiting for/)
  assert.equal(existsSync(join(dir, 'ran')), true)
  assert.deepEqual(readdirSync(queue), [])
})

test('a lock whose pid lives and started at the recorded time is held; one in the old format (the pid alone) too', async () => {
  const dir = project('proj-a', [WORK])
  for (const pidStart of [startOf(process.pid), undefined]) {
    const queue = scratch()
    plantLock(queue, { pid: process.pid, project: 'holder', pidStart })
    const { status, err } = await start(['--no-wait'], { cwd: dir, queue }).done
    assert.equal(status, 3, String(pidStart))
    assert.equal(err, `ci-local: the machine is busy: holder (pid ${process.pid})\n`)
    assert.equal(existsSync(join(queue, 'lock')), true, 'a live lock is never removed')
  }
})

for (const [name, queueEnv] of [
  ['with the queue', {}],
  ['without the queue', { CI_LOCAL_QUEUE: 'off' }],
]) {
  test(`events file of a run whose pid lives but started at another time: the next run takes it over (${name})`, async () => {
    const cache = scratch('cache-')
    const file = join(cache, 'ci-local', 'same-ci.ndjson')
    mkdirSync(join(cache, 'ci-local'), { recursive: true })
    const planted = (pidStart) =>
      JSON.stringify({ ts: new Date().toISOString(), event: 'run', project: 'same-ci', pid: process.pid, pidStart, total: 1, args: [] }) + '\n'
    const dir = project('same-ci', [WORK])
    const env = { XDG_CACHE_HOME: cache, ...queueEnv }

    writeFileSync(file, planted(WRONG_START))
    const taken = await start([], { cwd: dir, queue: scratch(), env }).done
    assert.equal(taken.status, 0, taken.err)
    assert.doesNotMatch(taken.err, /belongs to run/)
    const events = defaultEvents(cache, 'same-ci')
    assert.equal(events.at(-1).result, 'passed')
    assert.deepEqual(writers(events), [events[0].pid], 'the file is the new run’s alone')
    assert.notEqual(events[0].pid, process.pid)

    // The same file with the right start time is a live run’s: left alone.
    writeFileSync(file, planted(startOf(process.pid)))
    const kept = await start([], { cwd: dir, queue: scratch(), env: { ...env, CI_LOCAL_QUEUE: 'off' } }).done
    assert.match(kept.err, new RegExp(`the events file .* belongs to run ${process.pid}, still going`))
    assert.equal(defaultEvents(cache, 'same-ci').length, 1)
  })
}

// ------------------------------------------------ the start time, within a tolerance; pids 0 and 1

test('a ticket whose start time is 2 s off the real one is a live run’s (the clock was adjusted); 10 s off, a dead run’s', async () => {
  const dir = project('proj-a', [WORK])
  const real = startOf(process.pid)
  const queue = scratch()
  plantTicket(queue, process.pid, { ms: 1, pidStart: shifted(real, 2) })
  const busy = await start(['--no-wait'], { cwd: dir, queue }).done
  assert.equal(busy.status, 3)
  assert.equal(busy.err, `ci-local: the machine is busy: ghost (pid ${process.pid})\n`)
  assert.equal(existsSync(join(dir, 'ran')), false)

  const queue2 = scratch()
  plantTicket(queue2, process.pid, { ms: 1, pidStart: shifted(real, -10) })
  const free = await start([], { cwd: dir, queue: queue2 }).done
  assert.equal(free.status, 0, free.err)
  assert.doesNotMatch(free.out, /Waiting for/)
  assert.deepEqual(readdirSync(queue2), [])
})

test('a lock whose start time is 2 s off the real one is held; 10 s off, taken over', async () => {
  const dir = project('proj-a', [WORK])
  const real = startOf(process.pid)
  const queue = scratch()
  plantLock(queue, { pid: process.pid, project: 'holder', pidStart: shifted(real, -2) })
  const busy = await start(['--no-wait'], { cwd: dir, queue }).done
  assert.equal(busy.status, 3)
  assert.equal(existsSync(join(queue, 'lock')), true, 'a live lock is never removed')

  const queue2 = scratch()
  plantLock(queue2, { pid: process.pid, project: 'ghost', pidStart: shifted(real, 10) })
  const free = await start([], { cwd: dir, queue: queue2 }).done
  assert.equal(free.status, 0, free.err)
  assert.deepEqual(readdirSync(queue2), [])
})

test('a start time that is not a date cannot tell: the live pid decides, its ticket is kept', async () => {
  const dir = project('proj-a', [WORK])
  const queue = scratch()
  plantTicket(queue, process.pid, { ms: 1, pidStart: 'not a date' })
  const waited = await start([], { cwd: dir, queue, env: { CI_LOCAL_QUEUE_TIMEOUT: '1' } }).done
  assert.equal(waited.status, 3, waited.err)
  assert.match(waited.err, /gave up waiting/)
})

test('a ticket or a lock with pid 0 or 1 is nobody’s: ignored and removed, taken over', async () => {
  const dir = project('proj-a', [WORK])
  for (const pid of [0, 1]) {
    const queue = scratch()
    plantTicket(queue, pid, { ms: 1 })
    plantLock(queue, { pid, project: 'ghost' })
    const { status, out, err } = await start([], { cwd: dir, queue }).done
    assert.equal(status, 0, `pid ${pid}: ${err}`)
    assert.doesNotMatch(out, /Waiting for/, `pid ${pid}`)
    assert.deepEqual(readdirSync(queue), [], `pid ${pid}`)
  }
})

for (const pid of [0, 1]) {
  test(`events file of a run with pid ${pid}: nobody’s, the next run takes it over`, async () => {
    const cache = scratch('cache-')
    const file = join(cache, 'ci-local', 'same-ci.ndjson')
    mkdirSync(join(cache, 'ci-local'), { recursive: true })
    writeFileSync(file, JSON.stringify({ ts: new Date().toISOString(), event: 'run', project: 'same-ci', pid, total: 1, args: [] }) + '\n')
    const dir = project('same-ci', [WORK])
    const taken = await start([], { cwd: dir, queue: scratch(), env: { XDG_CACHE_HOME: cache, CI_LOCAL_QUEUE: 'off' } }).done
    assert.equal(taken.status, 0, taken.err)
    assert.doesNotMatch(taken.err, /belongs to run/)
    assert.equal(defaultEvents(cache, 'same-ci').at(-1).result, 'passed')
  })
}

// ------------------------------------------------ waiting too long (#2)

test('CI_LOCAL_QUEUE_TIMEOUT: a run that waits that long leaves the queue, says so, and exits 3', async () => {
  const queue = scratch()
  plantLock(queue, { pid: process.pid, project: 'holder' })
  const dir = project('proj-a', [WORK])
  const ev = eventsOf()
  const { status, out, err } = await start(['--events', ev], { cwd: dir, queue, env: { CI_LOCAL_QUEUE_TIMEOUT: '1' } }).done
  assert.equal(status, 3)
  assert.match(err, new RegExp(`^ci-local: gave up waiting after \\d+s for holder \\(pid ${process.pid}\\)\n$`))
  assert.match(out, new RegExp(`^Waiting for holder \\(pid ${process.pid}\\) · 0 ahead\n$`))
  assert.equal(existsSync(join(dir, 'ran')), false)
  assert.deepEqual(tickets(queue), [], 'its ticket is gone')
  assert.equal(readFileSync(join(queue, 'lock', 'pid'), 'utf8'), String(process.pid), 'the holder’s lock is left alone')
  assert.deepEqual(kinds(ev, 'run'), [])
})

test('CI_LOCAL_QUEUE_TIMEOUT: a run that gets its turn in time is not affected; 0 is no limit', async () => {
  const dir = project('proj-a', [WORK])
  for (const limit of ['60', '0']) {
    const { status, out, err } = await start([], { cwd: dir, queue: scratch(), env: { CI_LOCAL_QUEUE_TIMEOUT: limit } }).done
    assert.equal(status, 0, err)
    assert.doesNotMatch(out + err, /Waiting for|gave up/)
  }
})

test('CI_LOCAL_QUEUE_NOTICE: a waiting run says every so often that it still waits, and for whom', async () => {
  const queue = scratch()
  plantLock(queue, { pid: process.pid, project: 'holder' })
  const dir = project('proj-a', [WORK])
  const run = start([], { cwd: dir, queue, env: { CI_LOCAL_QUEUE_NOTICE: '1' } })
  const still = () => run.out.split('\n').filter((line) => line.startsWith('Still waiting for '))
  await until(() => still().length >= 2)
  run.child.kill('SIGTERM')
  const { status, out } = await run.done
  assert.equal(status, 143)
  const lines = out.split('\n')
  assert.equal(lines[0], `Waiting for holder (pid ${process.pid}) · 0 ahead`, 'the line on change is kept, and comes first')
  for (const line of still()) assert.match(line, new RegExp(`^Still waiting for holder \\(pid ${process.pid}\\) · 0 ahead · \\d+s$`))
  assert.deepEqual(waitingLines(out).length, 1, 'the change line is printed once')
})

test('CI_LOCAL_QUEUE_NOTICE=0 and the default (300 seconds) print no periodic line', async () => {
  const dir = project('proj-a', [WORK])
  for (const env of [{ CI_LOCAL_QUEUE_NOTICE: '0', CI_LOCAL_QUEUE_TIMEOUT: '2' }, { CI_LOCAL_QUEUE_TIMEOUT: '2' }]) {
    const queue = scratch()
    plantLock(queue, { pid: process.pid, project: 'holder' })
    const { status, out } = await start([], { cwd: dir, queue, env }).done
    assert.equal(status, 3)
    assert.doesNotMatch(out, /Still waiting/)
  }
})

test('CI_LOCAL_QUEUE_TIMEOUT and CI_LOCAL_QUEUE_NOTICE: anything but a whole number of seconds is a usage error, status 2, before anything runs', async () => {
  const dir = project('proj-a', [WORK])
  for (const name of ['CI_LOCAL_QUEUE_TIMEOUT', 'CI_LOCAL_QUEUE_NOTICE']) {
    for (const value of ['abc', '-1', '1.5', '1m']) {
      const queue = scratch()
      const { status, out, err } = await start([], { cwd: dir, queue, env: { [name]: value } }).done
      assert.equal(status, 2, `${name}=${value}`)
      assert.equal(err, `ci-local: ${name} must be a whole number of seconds (0: ${name === 'CI_LOCAL_QUEUE_TIMEOUT' ? 'no limit' : 'no periodic line'}), got '${value}'\n`)
      assert.equal(out, '')
      assert.equal(existsSync(join(dir, 'ran')), false)
      assert.deepEqual(readdirSync(queue), [])
    }
  }
  // An option that runs no step ignores them, as it does the rest of the queue's settings.
  const listed = await start(['--list'], { cwd: dir, queue: scratch(), env: { CI_LOCAL_QUEUE_TIMEOUT: 'abc' } }).done
  assert.equal(listed.status, 0, listed.err)
})

// ------------------------------------------------ several at once (CI_LOCAL_MAX_RUNS)

test('CI_LOCAL_MAX_RUNS=2: two runs go at once, each in its own slot; the third waits for one to end', async () => {
  const queue = scratch()
  const env = { CI_LOCAL_MAX_RUNS: '2' }
  const dirA = project('proj-a', [GATE])
  const dirB = project('proj-b', [GATE])
  const dirC = project('proj-c', [WORK])
  const evA = eventsOf()
  const evC = eventsOf()
  const runA = start(['--events', evA], { cwd: dirA, queue, env })
  await until(() => existsSync(join(dirA, 'started')))
  const runB = start([], { cwd: dirB, queue, env })
  await until(() => existsSync(join(dirB, 'started')))
  assert.doesNotMatch(runB.out, /Waiting for/, 'B does not wait for A')
  assert.deepEqual(readdirSync(queue).filter((name) => name.startsWith('lock')).sort(), ['lock', 'lock.2'])
  const pidA = kinds(evA, 'run')[0].pid

  const runC = start(['--events', evC], { cwd: dirC, queue, env })
  await until(() => runC.out.includes('Waiting for '))
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(existsSync(join(dirC, 'ran')), false, 'two are running: C waits')
  assert.deepEqual(waitingLines(runC.out), [`Waiting for proj-a (pid ${pidA}) · 2 ahead`])

  release(dirA)
  const c = await runC.done
  assert.equal(c.status, 0, c.err)
  assert.equal(existsSync(join(dirB, 'release')), false, 'C ran while B still held its slot')
  release(dirB)
  for (const result of await Promise.all([runA.done, runB.done])) assert.equal(result.status, 0, result.err)
  assert.deepEqual(readdirSync(queue), [])
})

test('CI_LOCAL_MAX_RUNS=2: two runs of the same project never go at once, and the waiting one keeps its place', async () => {
  const queue = scratch()
  const env = { CI_LOCAL_MAX_RUNS: '2' }
  const dirA = project('proj-a', [GATE])
  const dirA2 = project('proj-a', [WORK])
  const dirB = project('proj-b', [WORK])
  const evA = eventsOf()
  const runA = start(['--events', evA], { cwd: dirA, queue, env })
  await until(() => existsSync(join(dirA, 'started')))
  const pidA = kinds(evA, 'run')[0].pid
  const runA2 = start([], { cwd: dirA2, queue, env })
  await until(() => runA2.out.includes('Waiting for '))
  // A slot is free, but the run's own project holds the other.
  assert.deepEqual(waitingLines(runA2.out), [`Waiting for proj-a (pid ${pidA}) · 1 ahead`])
  const busy = await start(['--no-wait'], { cwd: dirA2, queue, env }).done
  assert.equal(busy.status, 3)
  assert.equal(busy.err, `ci-local: the machine is busy: proj-a (pid ${pidA})\n`)
  // First come, first served: another project comes after both, so it waits too.
  const runB = start([], { cwd: dirB, queue, env })
  await until(() => runB.out.includes('Waiting for '))
  assert.deepEqual(waitingLines(runB.out), [`Waiting for proj-a (pid ${pidA}) · 2 ahead`])
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(existsSync(join(dirA2, 'ran')), false)
  assert.equal(existsSync(join(dirB, 'ran')), false)
  release(dirA)
  for (const result of await Promise.all([runA.done, runA2.done, runB.done])) assert.equal(result.status, 0, result.err)
  assert.deepEqual(readdirSync(queue), [])
})

test('CI_LOCAL_MAX_RUNS=2: a slot held by a live process leaves the other free; both held, --no-wait is refused', async () => {
  const dir = project('proj-a', [WORK])
  const env = { CI_LOCAL_MAX_RUNS: '2' }
  const queue = scratch()
  plantLock(queue, { pid: process.pid, project: 'holder' })
  const free = await start([], { cwd: dir, queue, env }).done
  assert.equal(free.status, 0, free.err)
  assert.doesNotMatch(free.out, /Waiting for/)
  assert.deepEqual(readdirSync(queue), ['lock'], 'the holder’s slot is left alone; the run gave its own back')

  mkdirSync(join(queue, 'lock.2'))
  writeFileSync(join(queue, 'lock.2', 'project'), 'other')
  writeFileSync(join(queue, 'lock.2', 'pid'), `${process.pid}\n`)
  const busy = await start(['--no-wait'], { cwd: dir, queue, env }).done
  assert.equal(busy.status, 3)
  assert.equal(busy.err, `ci-local: the machine is busy: holder (pid ${process.pid})\n`)
})

test('CI_LOCAL_MAX_RUNS=2: a slot of a dead process is taken over', async () => {
  const queue = scratch()
  const dead = deadPid()
  plantLock(queue, { pid: process.pid, project: 'holder' })
  mkdirSync(join(queue, 'lock.2'))
  writeFileSync(join(queue, 'lock.2', 'project'), 'ghost')
  writeFileSync(join(queue, 'lock.2', 'pid'), `${dead}\n`)
  const dir = project('proj-a', [WORK])
  const { status, out, err } = await start([], { cwd: dir, queue, env: { CI_LOCAL_MAX_RUNS: '2' } }).done
  assert.equal(status, 0, err)
  assert.doesNotMatch(out, /Waiting for/)
  assert.deepEqual(readdirSync(queue), ['lock'])
})

// A `mv` that plays the run that breaks the same stale lock first: when ci-local
// moves a lock aside (to .stale.<pid>), that other run has already made the
// lock again, live. RACE=swap: the lock moved is the new live one (its pid
// written just before the move). RACE=remake: the live one is made just after
// the move, so the stale one moved cannot be put back.
function racingMv() {
  const dir = scratch('mv-')
  writeFileSync(
    join(dir, 'mv'),
    [
      '#!/bin/bash',
      'src="${@: -2:1}"; dst="${@: -1}"',
      'case "$dst" in */.stale.*) stale=1 ;; *) stale=0 ;; esac',
      'if [ $stale = 1 ] && [ "$RACE" = swap ]; then printf "%s\\n" "$LIVE_PID" >"$src/pid"; echo live >"$src/project"; fi',
      '/bin/mv "$@" || exit $?',
      'if [ $stale = 1 ] && [ "$RACE" = remake ]; then mkdir "$src" && printf "%s\\n" "$LIVE_PID" >"$src/pid" && echo live >"$src/project"; fi',
      '',
    ].join('\n')
  )
  chmodSync(join(dir, 'mv'), 0o755)
  return dir
}

test('breaking a stale lock is compare-and-move: a live lock made meanwhile is put back, or left alone', async () => {
  const dir = project('proj-a', [WORK])
  const mv = racingMv()
  for (const race of ['swap', 'remake']) {
    const queue = scratch()
    plantLock(queue, { pid: deadPid(), project: 'ghost' })
    const env = { RACE: race, LIVE_PID: String(process.pid), PATH: `${mv}:${FAKE_DOCKER}:${process.env.PATH}` }
    const { status, err } = await start(['--no-wait'], { cwd: dir, queue, env }).done
    assert.equal(status, 3, `${race}: the live lock holds the machine`)
    assert.equal(err, `ci-local: the machine is busy: live (pid ${process.pid})\n`, race)
    assert.equal(readFileSync(join(queue, 'lock', 'pid'), 'utf8'), `${process.pid}\n`, `${race}: the live lock is in place`)
    assert.deepEqual(readdirSync(join(queue, 'lock')).sort(), ['pid', 'project'], `${race}: nothing moved inside it`)
    assert.deepEqual(readdirSync(queue), ['lock'], `${race}: no .stale left, no ticket`)
    assert.equal(existsSync(join(dir, 'ran')), false)
  }
})

test('CI_LOCAL_MAX_RUNS: anything but a whole number from 1 to 99 is a usage error, status 2, before anything runs', async () => {
  const dir = project('proj-a', [WORK])
  for (const value of ['0', 'abc', '-1', '1.5', '100']) {
    const queue = scratch()
    const { status, out, err } = await start([], { cwd: dir, queue, env: { CI_LOCAL_MAX_RUNS: value } }).done
    assert.equal(status, 2, value)
    assert.equal(err, `ci-local: CI_LOCAL_MAX_RUNS must be a whole number from 1 to 99 (runs at once), got '${value}'\n`)
    assert.equal(out, '')
    assert.deepEqual(readdirSync(queue), [])
  }
})

// ------------------------------------------------ the user's settings file

/** A home with these files (path relative to it → content; objects as JSON). */
function home(files) {
  const dir = scratch('home-')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return dir
}
const userEnv = (dir, extra = {}) => ({ HOME: dir, XDG_CONFIG_HOME: '', CI_LOCAL_USER_CONFIG: '', ...extra })
const v1 = (settings) => ({ schema: 'ci-local.config/v1', ...settings })

test('~/.config/ci-local/config.json sets maxRuns: a slot held by another leaves the second free', async () => {
  const queue = scratch()
  plantLock(queue, { pid: process.pid, project: 'holder' })
  const dir = project('proj-a', [WORK])
  const h = home({ '.config/ci-local/config.json': v1({ maxRuns: 2 }) })
  const { status, out, err } = await start([], { cwd: dir, queue, env: userEnv(h) }).done
  assert.equal(status, 0, err)
  assert.equal(err, '')
  assert.doesNotMatch(out, /Waiting for/)
})

test('~/.ci-local/config.json comes before ~/.config/ci-local/config.json; XDG_CONFIG_HOME moves the second; the environment wins', async () => {
  const dir = project('proj-a', [WORK])
  const busy = async (env) => {
    const queue = scratch()
    plantLock(queue, { pid: process.pid, project: 'holder' })
    return (await start(['--no-wait'], { cwd: dir, queue, env }).done).status
  }
  const both = home({ '.ci-local/config.json': v1({ maxRuns: 1 }), '.config/ci-local/config.json': v1({ maxRuns: 2 }) })
  assert.equal(await busy(userEnv(both)), 3, '~/.ci-local/config.json: one at a time')
  const xdg = home({ 'cfg/ci-local/config.json': v1({ maxRuns: 2 }) })
  const at = { XDG_CONFIG_HOME: join(xdg, 'cfg') }
  assert.equal(await busy(userEnv(xdg, at)), 0)
  assert.equal(await busy(userEnv(xdg, { ...at, CI_LOCAL_MAX_RUNS: '1' })), 3, 'the environment wins')
  assert.equal(await busy(userEnv(xdg, { ...at, CI_LOCAL_USER_CONFIG: 'off' })), 3, 'off: no file')
  const other = join(scratch('cfg-'), 'mine.json')
  writeFileSync(other, JSON.stringify(v1({ maxRuns: 2 })))
  assert.equal(await busy(userEnv(scratch('home-'), { CI_LOCAL_USER_CONFIG: other })), 0, 'CI_LOCAL_USER_CONFIG names the file')
})

test('the queue settings of the file: queue.timeout gives up, queue.enabled false runs without waiting', async () => {
  const dir = project('proj-a', [WORK])
  const queue = scratch()
  plantLock(queue, { pid: process.pid, project: 'holder' })
  const timed = await start([], { cwd: dir, queue, env: userEnv(home({ '.ci-local/config.json': v1({ queue: { timeout: 1, notice: 0 } }) })) }).done
  assert.equal(timed.status, 3)
  assert.match(timed.err, /^ci-local: gave up waiting after \d+s for holder/)
  const off = await start([], { cwd: dir, queue, env: userEnv(home({ '.ci-local/config.json': v1({ queue: { enabled: false } }) })) }).done
  assert.equal(off.status, 0, off.err)
  assert.doesNotMatch(off.out, /Waiting for/)
})

test('a settings file that is not valid is said on stderr and ignored whole: the run goes on with the defaults', async () => {
  const dir = project('proj-a', [WORK])
  const cases = [
    ['{ nope', /is not JSON \(/],
    [{ maxRuns: 2 }, /: schema must be "ci-local\.config\/v1", got undefined: its settings are ignored\n/],
    [{ schema: 'ci-local.config/v2', maxRuns: 2 }, /: schema must be "ci-local\.config\/v1", got "ci-local\.config\/v2"/],
    [v1({ maxRuns: 2, events: '/tmp/x' }), /: unknown key "events": its settings are ignored\n/],
    [v1({ maxRuns: 2, queue: { speed: 1 } }), /: unknown key "queue\.speed"/],
    [v1({ maxRuns: '2' }), /: "maxRuns" must be a whole number from 1 to 99, got "2"/],
    [v1({ maxRuns: 0 }), /: "maxRuns" must be a whole number from 1 to 99, got 0/],
    [v1({ maxRuns: 2, queue: { dir: 'relative' } }), /: "queue\.dir" must be an absolute path, got "relative"/],
    [v1({ maxRuns: 2, queue: [] }), /: "queue" must be an object/],
  ]
  for (const [content, said] of cases) {
    const h = home({ '.ci-local/config.json': content })
    const queue = scratch()
    plantLock(queue, { pid: process.pid, project: 'holder' })
    const { status, err } = await start(['--no-wait'], { cwd: dir, queue, env: userEnv(h) }).done
    assert.equal(status, 3, `${JSON.stringify(content)}: maxRuns not taken, one at a time`)
    assert.match(err, new RegExp(`^ci-local: ${join(h, '.ci-local', 'config.json').replace(/[.]/g, '\\.')}`))
    assert.match(err, said, JSON.stringify(content))
  }
})
