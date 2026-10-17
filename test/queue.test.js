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

const BIN = fileURLToPath(new URL('../bin/ci-local', import.meta.url))
const FAKE_DOCKER = fileURLToPath(new URL('./fixture/fake-docker/', import.meta.url))
chmodSync(join(FAKE_DOCKER, 'docker'), 0o755)

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
  for (const name of ['CI_LOCAL_QUIET', 'CI_LOCAL_EVENTS', 'CI_LOCAL_QUEUE', 'CI_LOCAL_QUEUE_DIR', 'CI_LOCAL_QUEUE_POLL'])
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
async function until(check, timeoutMs = 15000) {
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

/** A ticket as a run would have left it. */
function plantTicket(queue, pid, { ms = 1, name = 'ghost' } = {}) {
  mkdirSync(queue, { recursive: true })
  writeFileSync(join(queue, `${pad(ms, 15)}-${pad(pid, 10)}`), `project=${name}\npid=${pid}\nrepo=/nowhere\n`)
}

function plantLock(queue, { pid, project: name } = {}) {
  mkdirSync(join(queue, 'lock'), { recursive: true })
  if (name) writeFileSync(join(queue, 'lock', 'project'), name)
  if (pid !== undefined) writeFileSync(join(queue, 'lock', 'pid'), String(pid))
}

test('two runs: the second waits for the first’s end, says whom it waits for, and records it', async () => {
  const queue = scratch()
  const dirA = project('proj-a', [GATE])
  const dirB = project('proj-b', [WORK])
  const evA = eventsOf()
  const evB = eventsOf()
  const runA = start(['--events', evA], { cwd: dirA, queue })
  await until(() => existsSync(join(dirA, 'started')))
  const pidA = kinds(evA, 'run')[0].pid
  // The first run's ticket and lock say who holds the machine.
  const [ticket] = tickets(queue)
  assert.equal(tickets(queue).length, 1)
  assert.equal(ticket.slice(-10), pad(pidA, 10))
  assert.equal(readFileSync(join(queue, ticket), 'utf8'), `project=proj-a\npid=${pidA}\nrepo=${realpathSync(dirA)}\n`)
  assert.equal(readFileSync(join(queue, 'lock', 'pid'), 'utf8').trim(), String(pidA))

  const runB = start(['--events', evB], { cwd: dirB, queue })
  await until(() => runB.out.includes('Waiting for '))
  // Polled a few times meanwhile: the line is not repeated, nothing ran.
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.deepEqual(waitingLines(runB.out), [`Waiting for proj-a (pid ${pidA}) · 1 ahead`])
  assert.equal(existsSync(join(dirB, 'ran')), false)
  assert.deepEqual(kinds(evB, 'run'), [])
  assert.equal(tickets(queue).length, 2)

  release(dirA)
  const [a, b] = await Promise.all([runA.done, runB.done])
  assert.equal(a.status, 0, a.err)
  assert.equal(b.status, 0, b.err)
  assert.ok(at(evB, 'start') >= at(evA, 'end'), 'B’s first step starts after A’s end')
  assert.ok(at(evB, 'run') >= at(evA, 'end'))
  assert.match(b.out, /\nQueue: your turn after \d+s\n/)
  assert.doesNotMatch(a.out, /Waiting for |Queue: your turn/)
  assert.ok(b.out.indexOf('Queue: your turn') < b.out.indexOf('ci-local 0.4.0: 1 steps'), 'before the banner')
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
  assert.deepEqual(
    events(evB).map((event) => event.event),
    ['queued']
  )
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
    assert.equal(readFileSync(join(queue, 'lock', 'pid'), 'utf8').trim(), String(kinds(evA, 'run')[0].pid))
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
  assert.equal(lines[0], '> ⏳ **ci-local** · queued · behind proj-a (1 ahead)')
  assert.match(lines[1], new RegExp(`^> \`ci-local --events ${evB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\` · project \`proj-b\` · not a git checkout · waiting \\d+s$`))
  assert.equal(lines[2], `> Follow it: \`tail -f ${evB}\``)
  release(dirA)
  await Promise.all([runA.done, runB.done])
  const after = spawnSync('bash', [BIN, '--status', '--events', evB], { encoding: 'utf8' })
  assert.equal(after.status, 0)
  assert.match(after.stdout, /^> ✅ \*\*ci-local\*\* · passed\n/)
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
  const shown = spawnSync('bash', [BIN, '--status'], { cwd: dir, encoding: 'utf8', env: base })
  assert.equal(shown.status, 0, shown.stderr)
  assert.match(shown.stdout, /^> ✅ \*\*ci-local\*\* · passed\n/)
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

test('an events file whose directory takes no .claim: the run writes it without a claim, as before 0.4.0', async () => {
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

test('a stale claim that cannot be removed does not spin: the run gives it up at once', async () => {
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
