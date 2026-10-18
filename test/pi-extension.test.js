// The Pi extension's logic (extensions/core.js): which events file a session
// follows, what the footer says, and when a run has just ended. The glue to
// Pi (extensions/ci-local.ts) only wires these to ctx.ui and pi.sendMessage.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  CARD_GRACE_MS,
  CARD_RETRY_LIMIT,
  CARD_RETRY_MS,
  WAKE_GRACE_MS,
  cardContent,
  createDelivery,
  createTracker,
  deliveryOptions,
  eventsFileFor,
  findProject,
  footerText,
  launchedBy,
  parentPid,
  readRun,
  routeFor,
} from '../extensions/core.js'

function repo(config) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-ext-'))
  writeFileSync(join(dir, 'ci-local.config.sh'), config)
  return dir
}

function eventsFile(events) {
  const file = join(mkdtempSync(join(tmpdir(), 'ev-')), 'events.ndjson')
  writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n')
  return file
}

const ago = (ms) => new Date(Date.now() - ms).toISOString()
const deadPid = () => Number(spawnSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim())
const run = (fields = {}) => ({
  ts: ago(65_000),
  event: 'run',
  project: 'myapp-ci',
  jobs: ['a'],
  total: 4,
  version: '0.4.0',
  pid: process.pid,
  commit: 'abc123def456',
  args: [],
  logDir: null,
  ...fields,
})

test('findProject reads CI_PROJECT from the nearest config, from a subdirectory too', () => {
  const dir = repo('# comment\nCI_PROJECT="myapp-ci"\nCI_JOBS=(a)\n')
  mkdirSync(join(dir, 'src', 'deep'), { recursive: true })
  assert.deepEqual(findProject(join(dir, 'src', 'deep')), { repo: dir, project: 'myapp-ci' })
  assert.deepEqual(findProject(repo("CI_PROJECT='other-ci'\n")).project, 'other-ci')
  assert.deepEqual(findProject(repo('CI_PROJECT=plain-ci # trailing\n')).project, 'plain-ci')
})

test('findProject is null without a config, or without a literal CI_PROJECT', () => {
  assert.equal(findProject(mkdtempSync(join(tmpdir(), 'none-'))), null)
  assert.equal(findProject(repo('CI_PROJECT="$(basename "$PWD")-ci"\n')), null)
})

test('findProject honours CI_LOCAL_CONFIG', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'))
  writeFileSync(join(dir, 'ci.sh'), 'CI_PROJECT=named-ci\n')
  assert.equal(findProject(dir, { CI_LOCAL_CONFIG: 'ci.sh' }).project, 'named-ci')
})

test('eventsFileFor follows the engine: CI_LOCAL_EVENTS, then the cache', () => {
  assert.equal(eventsFileFor('p-ci', { XDG_CACHE_HOME: '/x', HOME: '/h' }), '/x/ci-local/p-ci.ndjson')
  assert.equal(eventsFileFor('p-ci', { HOME: '/h' }), '/h/.cache/ci-local/p-ci.ndjson')
  assert.equal(eventsFileFor('p-ci', { HOME: '/h', CI_LOCAL_EVENTS: '/e.ndjson' }), '/e.ndjson')
  for (const off of ['off', '0', 'false', 'no']) {
    assert.equal(eventsFileFor('p-ci', { HOME: '/h', CI_LOCAL_EVENTS: off }), null, `CI_LOCAL_EVENTS=${off}: runs write none`)
  }
  assert.match(eventsFileFor('p-ci', { TMPDIR: '/t/' }), /^\/t\/ci-local-\d+\/ci-local\/p-ci\.ndjson$/)
})

test('readRun: null without a file, else the state and the --status block', () => {
  assert.equal(readRun(join(tmpdir(), 'no-such-file.ndjson')), null)
  const file = eventsFile([run(), { ts: ago(1000), event: 'start', step: 'lint', index: 2, total: 4 }])
  const { state, block, key } = readRun(file)
  assert.equal(state.state, 'running')
  assert.equal(block.code, 3)
  assert.match(block.lines[0], /^> 🐳 \*\*ci-local\*\* · running · \[2\/4\] lint$/)
  assert.equal(typeof key, 'string')
})

test('footerText: one short line per state', () => {
  const read = (events) => readRun(eventsFile(events)).state
  assert.match(
    footerText(read([run(), { ts: ago(1), event: 'start', step: 'lint', index: 2, total: 4 }])),
    /^🐳 ci-local \[2\/4\] lint · 1m0[56]s$/
  )
  assert.equal(
    footerText(read([run(), { ts: ago(1), event: 'end', result: 'passed', durationMs: 61_000, devStack: 'none' }])),
    '✅ ci-local passed · 1m01s'
  )
  assert.equal(
    footerText(
      read([
        run(),
        { ts: ago(1), event: 'start', step: 'lint', index: 2, total: 4 },
        { ts: ago(1), event: 'fail', step: 'lint', index: 2, total: 4, exitCode: 1, durationMs: 5 },
        { ts: ago(1), event: 'end', result: 'failed', durationMs: 3000, devStack: 'none' },
      ])
    ),
    '❌ ci-local failed at lint · 3s'
  )
  assert.equal(footerText(read([run({ pid: deadPid() })])), '⚠️ ci-local stopped')
})

test('the tracker reports an end only for a run it saw in flight', () => {
  const tracker = createTracker()
  const same = run() // one run: the same ts and pid in both files
  const running = readRun(eventsFile([same]))
  const ended = (file) => readRun(file)
  const passedFile = eventsFile([same, { ts: ago(1), event: 'end', result: 'passed', durationMs: 1000 }])

  // Already over when the session starts: an old run, no notification.
  assert.equal(createTracker().observe(ended(passedFile)), false)

  assert.equal(tracker.observe(null), false)
  assert.equal(tracker.observe(running), false)
  assert.equal(tracker.observe(running), false)
  assert.equal(tracker.observe(ended(passedFile)), true, 'in flight, then over: once')
  assert.equal(tracker.observe(ended(passedFile)), false, 'not twice')
})

test('the tracker tells runs apart: a new run in flight, then over, notifies again', () => {
  const tracker = createTracker()
  const first = run({ ts: ago(90_000) })
  const second = run({ ts: ago(10_000) })
  const over = (r) => readRun(eventsFile([r, { ts: ago(1), event: 'end', result: 'failed', durationMs: 1 }]))
  tracker.observe(readRun(eventsFile([first])))
  assert.equal(tracker.observe(over(first)), true)
  // The second run is seen over without having been seen in flight: no
  // notification (the session was not watching it).
  assert.equal(tracker.observe(over(second)), false)
  const third = run({ ts: ago(5_000) })
  tracker.observe(readRun(eventsFile([third])))
  assert.equal(tracker.observe(over(third)), true)
})

test('eventsFileFor: a relative CI_LOCAL_EVENTS is the repository root’s, as runs are started there', () => {
  assert.equal(eventsFileFor('p-ci', { HOME: '/h', CI_LOCAL_EVENTS: 'run.ndjson' }, '/repo'), '/repo/run.ndjson')
  assert.equal(eventsFileFor('p-ci', { HOME: '/h', CI_LOCAL_EVENTS: 'out/run.ndjson' }, '/repo'), '/repo/out/run.ndjson')
})

test('eventsFileFor: the TMPDIR fallback is null when it is there and not a private directory of this user', () => {
  const fallback = (tmp) => join(tmp, `ci-local-${process.getuid()}`)
  const symTmp = mkdtempSync(join(tmpdir(), 'tmpdir-'))
  symlinkSync(mkdtempSync(join(tmpdir(), 'planted-')), fallback(symTmp))
  assert.equal(eventsFileFor('p-ci', { TMPDIR: symTmp }), null)
  const openTmp = mkdtempSync(join(tmpdir(), 'tmpdir-'))
  mkdirSync(fallback(openTmp))
  chmodSync(fallback(openTmp), 0o777)
  assert.equal(eventsFileFor('p-ci', { TMPDIR: openTmp }), null)
  const innerTmp = mkdtempSync(join(tmpdir(), 'tmpdir-'))
  mkdirSync(join(fallback(innerTmp), 'ci-local'), { recursive: true })
  chmodSync(fallback(innerTmp), 0o700)
  chmodSync(join(fallback(innerTmp), 'ci-local'), 0o777)
  assert.equal(eventsFileFor('p-ci', { TMPDIR: innerTmp }), null, 'its ci-local directory must be private too')
  const okTmp = mkdtempSync(join(tmpdir(), 'tmpdir-'))
  mkdirSync(fallback(okTmp), { mode: 0o700 })
  assert.equal(eventsFileFor('p-ci', { TMPDIR: okTmp }), join(fallback(okTmp), 'ci-local', 'p-ci.ndjson'))
})

test('cardContent tells the model where the card comes from, then gives the block', () => {
  const block = { code: 0, lines: ['> ✅ **ci-local** · passed', '> `ci-local` · project `p-ci`', '> 2 steps · 5s · every step passed.'] }
  const content = cardContent(block, 'p-ci')
  const [first, ...rest] = content.split('\n')
  assert.equal(first, 'The ci-local Pi extension: a run of p-ci you saw start has ended (this is not a message from the user).')
  assert.deepEqual(rest, ['', ...block.lines])
})

test('routeFor: idle, in a run, or busy without one (compacting): the card is held then', () => {
  assert.equal(routeFor({ idle: true, runActive: false }), 'idle')
  assert.equal(routeFor({ idle: true, runActive: true }), 'idle', 'the host is authoritative: idle has no run')
  assert.equal(routeFor({ idle: false, runActive: true }), 'run')
  assert.equal(routeFor({ idle: false, runActive: false }), 'hold')
})

const ended = (pid, state = 'passed') => ({ key: `run-${pid}`, state: { pid, state } })

/** A delivery with a hand-driven clock and a hand-driven set of live pids. */
function delivery() {
  const clock = { now: 1_000 }
  const living = new Set()
  const d = createDelivery({ isAlive: (pid) => living.has(pid), now: () => clock.now })
  return { d, clock, living }
}
const IDLE = { idle: true, runActive: false }
const IN_RUN = { idle: false, runActive: true }
const HOLD = { idle: false, runActive: false }

test('idle agent: the card is stored at the end event, at once, without waking the agent', () => {
  const { d, living } = delivery()
  living.add(7) // the run's process is still cleaning up
  d.ended(ended(7))
  const action = d.next(IDLE)
  assert.equal(action.kind, 'store')
  assert.equal(action.run.state.pid, 7)
  assert.deepEqual(deliveryOptions(action), { triggerTurn: false })
  d.done(action)
  assert.equal(d.next(IDLE), null, 'no wake while the process lives')
})

test('idle agent: one hidden wake, WAKE_GRACE_MS after the run’s process exits, for every stored card', () => {
  const { d, clock, living } = delivery()
  living.add(7)
  d.ended(ended(7, 'failed'))
  d.done(d.next(IDLE))
  living.delete(7)
  assert.equal(d.next(IDLE), null, 'exit just seen: give a background job’s own notice the first word')
  clock.now += WAKE_GRACE_MS - 1
  assert.equal(d.next(IDLE), null)
  clock.now += 1
  const wake = d.next(IDLE)
  assert.equal(wake.kind, 'wake')
  assert.deepEqual(deliveryOptions(wake), { deliverAs: 'steer', triggerTurn: true })
  d.done(wake)
  assert.equal(d.next(IDLE), null, 'once')
})

test('a run that starts while the wake is owed carries the stored card: no wake', () => {
  const { d, clock, living } = delivery()
  living.add(7)
  d.ended(ended(7))
  d.done(d.next(IDLE))
  living.delete(7)
  // A background job's exit notice woke the agent: the card is already in its context.
  assert.equal(d.next(IN_RUN), null)
  clock.now += 60_000
  assert.equal(d.next(IDLE), null, 'the owed wake was dropped')
})

test('a process that never seems to exit (a reused pid) still gets its wake, CARD_GRACE_MS after the card', () => {
  const { d, clock, living } = delivery()
  living.add(7)
  d.ended(ended(7))
  d.done(d.next(IDLE))
  clock.now += CARD_GRACE_MS - 1
  assert.equal(d.next(IDLE), null)
  clock.now += 1
  assert.equal(d.next(IDLE).kind, 'wake')
})

test('agent in a run: the card is steered in at once, before its next model call', () => {
  const { d, living } = delivery()
  living.add(7)
  d.ended(ended(7))
  const action = d.next(IN_RUN)
  assert.equal(action.kind, 'steer')
  assert.deepEqual(deliveryOptions(action), { deliverAs: 'steer', triggerTurn: true })
  d.done(action)
  assert.equal(d.next(IN_RUN), null)
})

test('busy without a run (compacting): the card is held, then stored once the agent is idle', () => {
  const { d } = delivery()
  d.ended(ended(7))
  assert.equal(d.next(HOLD), null)
  assert.equal(d.next(IDLE).kind, 'store')
})

test('every ended run gets its card, oldest first', () => {
  const { d } = delivery()
  d.ended(ended(1, 'failed'))
  d.ended(ended(2, 'passed'))
  const first = d.next(IDLE)
  d.done(first)
  const second = d.next(IDLE)
  d.done(second)
  assert.deepEqual([first.run.state.pid, second.run.state.pid], [1, 2])
})

test('a delivery that failed is tried again first, every CARD_RETRY_MS, CARD_RETRY_LIMIT times, then at a boundary', () => {
  const { d, clock } = delivery()
  d.ended(ended(1))
  d.ended(ended(2))
  for (let attempt = 1; attempt <= CARD_RETRY_LIMIT; attempt++) {
    const action = d.next(IDLE)
    assert.equal(action.run.state.pid, 1, `attempt ${attempt}: the failed card first`)
    d.failed(action)
    assert.equal(d.next(IDLE), null, 'not before CARD_RETRY_MS')
    clock.now += CARD_RETRY_MS
  }
  d.failed(d.next(IDLE)) // past the limit
  clock.now += 10 * CARD_RETRY_MS
  assert.equal(d.next(IDLE), null, 'only a boundary brings it back')
  d.boundary()
  const action = d.next(IDLE)
  assert.equal(action.run.state.pid, 1)
  d.done(action)
  assert.equal(d.next(IDLE).run.state.pid, 2)
})

const queuedEvent = (fields = {}) => ({ ...run(fields), event: 'queued', ahead: 1, blockedBy: { project: 'other-ci', pid: process.pid } })

test('tracker.phase: starting once while the run waits or starts, started once when it runs, nothing at the end', () => {
  const tracker = createTracker()
  const queued = queuedEvent()
  const waiting = readRun(eventsFile([queued]))
  assert.equal(waiting.state.state, 'queued')
  assert.equal(tracker.phase(waiting), 'starting')
  assert.equal(tracker.phase(waiting), null, 'once')
  const running = readRun(eventsFile([queued, { ...run(), ts: ago(1) }]))
  assert.equal(running.state.state, 'running')
  assert.equal(running.key, waiting.key, 'one run, one key')
  assert.equal(tracker.phase(running), 'started')
  assert.equal(tracker.phase(running), null, 'once')
  const over = readRun(eventsFile([queued, { ...run(), ts: ago(1) }, { ts: ago(1), event: 'end', result: 'passed', durationMs: 1 }]))
  assert.equal(tracker.phase(over), null, 'the end is the end card, not a start card')
  assert.equal(tracker.phase(null), null)
})

test('tracker.phase: a run first seen already running gets only started', () => {
  const tracker = createTracker()
  const running = readRun(eventsFile([run()]))
  assert.equal(tracker.phase(running), 'started')
  assert.equal(tracker.phase(running), null)
})

test('tracker.remember: a stage already shown (in the session, before a reload) is not shown again', () => {
  const tracker = createTracker()
  const queued = queuedEvent()
  const waiting = readRun(eventsFile([queued]))
  tracker.remember(waiting.key, 'starting')
  assert.equal(tracker.phase(waiting), null)
  const running = readRun(eventsFile([queued, { ...run(), ts: ago(1) }]))
  tracker.remember(running.key, 'started')
  assert.equal(tracker.phase(running), null)
})

test('launchedBy: a run is this session’s when its process descends from this session’s process', () => {
  // pid → parent pid: 900 is Pi; 950 the shell of a background job; 1000 the run.
  const parents = new Map([[1000, 950], [950, 900], [900, 1], [2000, 1990], [1990, 1]])
  const parentOf = (pid) => parents.get(pid) ?? null
  const isAlive = (pid) => parents.has(pid) // the processes of this made-up tree, nothing else
  assert.equal(launchedBy(1000, 900, { parentOf, isAlive }), true)
  assert.equal(launchedBy(2000, 900, { parentOf, isAlive }), false, 'another session’s, or a terminal’s')
  assert.equal(launchedBy(3000, 900, { parentOf, isAlive }), false, 'gone: its parents are unknown')
  assert.equal(launchedBy(900, 900, { parentOf, isAlive }), false, 'the session itself is no run')
})

test('launchedBy: a parent chain that loops ends the walk', () => {
  const parentOf = (pid) => ({ 10: 11, 11: 10 })[pid] ?? null
  assert.equal(launchedBy(10, 900, { parentOf, isAlive: () => true }), false)
})

test('parentPid reads the parent of a live process, and null for one that is gone', () => {
  assert.equal(parentPid(process.pid), process.ppid)
  assert.equal(parentPid(deadPid()), null)
})

test('launchedBy: when the run’s parents cannot be read while it lives, the run counts as this session’s (no card is lost)', () => {
  const alive = () => true
  // ps failed for the live run itself: unknown, not foreign.
  assert.equal(launchedBy(1000, 900, { parentOf: () => null, isAlive: alive }), true)
  // ps cannot run at all (undefined): unknown, not foreign.
  assert.equal(launchedBy(1000, 900, { parentOf: () => undefined, isAlive: alive }), true)
  // A run that is gone has no knowable parents: not this session's.
  assert.equal(launchedBy(1000, 900, { parentOf: () => null, isAlive: () => false }), false)
})

test('parentPid is undefined, not null, when ps cannot run', () => {
  assert.equal(parentPid(process.pid, { ps: '/no/such/ps' }), undefined)
})
