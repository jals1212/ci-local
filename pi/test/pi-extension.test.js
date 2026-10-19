// The Pi extension's logic (extensions/core.js): which events file a session
// follows, what the footer says, and when a run has just ended. The glue to
// Pi (extensions/ci-local.ts) only wires these to ctx.ui and pi.sendMessage.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
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
  createStatusLine,
  createTracker,
  deliveryOptions,
  eventsFileFor,
  findProject,
  footerText,
  ciLocalBin,
  exitCard,
  launchReport,
  launchRun,
  outputTail,
  pruneLaunchOutputs,
  waitForStart,
  launchedBy,
  ownsRun,
  parentPid,
  readRun,
  routeFor,
  markDelivered,
  readDelivered,
  staleAtStart,
} from '../extensions/core.js'
import { fakeCiLocal } from './fixture/fake-ci-local.js'

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
  assert.match(block.lines[0], /^> 🚦 ⧗ \*\*ci-local\*\* · running · \[2\/4\] lint$/)
  assert.equal(typeof key, 'string')
})

test('footerText: one short line per state', () => {
  const read = (events) => readRun(eventsFile(events)).state
  assert.match(
    footerText(read([run(), { ts: ago(1), event: 'start', step: 'lint', index: 2, total: 4 }])),
    /^🚦 ci-local · ⧗ \[2\/4\] lint · 1m0[56]s$/
  )
  assert.equal(
    footerText(read([run(), { ts: ago(1), event: 'end', result: 'passed', durationMs: 61_000, devStack: 'none' }])),
    '🚦 ci-local · ✓ passed · 1m01s'
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
    '🚦 ci-local · ✗ failed at lint · 3s'
  )
  assert.equal(footerText(read([run({ pid: deadPid() })])), '🚦 ci-local · ⊘ stopped')
})

test('footerText: a queued run says where it stands, not only who runs', () => {
  const queued = (ahead, blockedBy) => ({ state: 'queued', elapsedMs: 0, ahead, blockedBy })
  // Two runs behind the same one tell apart by how many are ahead of each.
  assert.equal(footerText(queued(1, { project: 'erp-ci', pid: 1 })), '🚦 ci-local · ◌ queued · 1 ahead (erp-ci running)')
  assert.equal(footerText(queued(2, { project: 'erp-ci', pid: 1 })), '🚦 ci-local · ◌ queued · 2 ahead (erp-ci running)')
  // Behind a lock holder with no ticket: nobody counted ahead.
  assert.equal(footerText(queued(0, { project: 'erp-ci', pid: 1 })), '🚦 ci-local · ◌ queued · erp-ci running')
  assert.equal(footerText(queued(3, null)), '🚦 ci-local · ◌ queued · 3 ahead')
  assert.equal(footerText(queued(undefined, null)), '🚦 ci-local · ◌ queued', 'no count: none said')
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
  const block = { code: 0, lines: ['> 🚦 ✓ **ci-local** · passed', '> `ci-local` · project `p-ci`', '> 2 steps · 5s · every step passed.'] }
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

test('the delivery asks whether the run’s process is the run’s, with the start time the run recorded', () => {
  const asked = []
  const clock = { now: 1_000 }
  const d = createDelivery({ isAlive: (pid, pidStart) => (asked.push([pid, pidStart]), true), now: () => clock.now })
  d.ended({ key: 'run-7', state: { pid: 7, pidStart: 'Mon Jan  1 00:00:00 2001', state: 'passed' } })
  d.done(d.next(IDLE))
  d.next(IDLE)
  assert.deepEqual(asked, [[7, 'Mon Jan  1 00:00:00 2001']])
})

test('launchedBy: the start time of the run goes to the liveness check', () => {
  const asked = []
  const isAlive = (pid, pidStart) => (asked.push([pid, pidStart]), true)
  assert.equal(launchedBy(1000, 900, { parentOf: () => null, isAlive, pidStart: 'S' }), true)
  assert.deepEqual(asked, [[1000, 'S']])
})

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

test('ownsRun: a run that names its Pi session belongs to that session alone; one that names none falls back to its process tree', () => {
  const own = { state: { session: 'me', pid: 1 } }
  const other = { state: { session: 'someone-else', pid: 1 } }
  const unnamed = { state: { session: null, pid: 1 } }
  const tree = (answer) => () => answer
  assert.equal(ownsRun(own, { sessionId: 'me', launched: tree(false) }), true, 'its session, even orphaned')
  assert.equal(ownsRun(other, { sessionId: 'me', launched: tree(true) }), false, 'another session’s, whatever the tree says')
  assert.equal(ownsRun(unnamed, { sessionId: 'me', launched: tree(true) }), true, 'a background job: the tree decides')
  assert.equal(ownsRun(unnamed, { sessionId: 'me', launched: tree(false) }), false, 'a terminal’s')
})

test('ownsRun: a run that names no session is the session’s when the pids it recorded at start include the session’s process', () => {
  const run = (ancestors) => ({ state: { session: null, pid: 1, ancestors } })
  const walk = (answer) => () => answer
  const mine = { sessionId: 'me', sessionPid: 900 }
  assert.equal(ownsRun(run([950, 900, 800]), { ...mine, launched: walk(false) }), true, 'orphaned since: the live walk finds nothing')
  assert.equal(ownsRun(run([950, 700]), { ...mine, launched: walk(false) }), false, 'another session’s or a terminal’s: not among them')
  assert.equal(ownsRun(run([950, 700]), { ...mine, launched: walk(true) }), true, 'not recorded, but the live walk finds the session')
  assert.equal(ownsRun(run(undefined), { ...mine, launched: walk(true) }), true, 'an event from before 0.6.0: the live walk decides')
  assert.equal(ownsRun(run(undefined), { ...mine, launched: walk(false) }), false)
  assert.equal(ownsRun(run([]), { ...mine, launched: walk(false) }), false, 'ps could not say at start: the live walk decides')
})

test('ownsRun: the session a run names beats its recorded pids', () => {
  const other = { state: { session: 'someone-else', pid: 1, ancestors: [900] } }
  assert.equal(ownsRun(other, { sessionId: 'me', sessionPid: 900, launched: () => true }), false)
})

test('ownsRun checks this process’s pid by default', () => {
  const run = { state: { session: null, pid: 1, ancestors: [process.pid] } }
  assert.equal(ownsRun(run, { sessionId: 'me', launched: () => false }), true)
})

test('runState carries the pids a run recorded above it, or null', () => {
  assert.deepEqual(readRun(eventsFile([run({ ancestors: [7, 5] })])).state.ancestors, [7, 5])
  assert.equal(readRun(eventsFile([run()])).state.ancestors, null)
})

test('runState carries the session a run names, or null', () => {
  const named = readRun(eventsFile([run({ session: 'me' })]))
  assert.equal(named.state.session, 'me')
  assert.equal(readRun(eventsFile([run()])).state.session, null)
})

test('staleAtStart: a run already over when a session starts is hidden once its result was delivered; a reload shows it only if this session showed it', () => {
  const over = readRun(eventsFile([run(), { ts: ago(1000), event: 'end', result: 'passed', durationMs: 1000 }]))
  const live = readRun(eventsFile([run()]))
  const by = (session, key = over.key) => ({ key, sessions: session ? [session] : [] })
  const at = (reason, delivered) => ({ reason, sessionId: 'me', delivered })
  assert.equal(staleAtStart(null, at('startup', null)), null, 'no run: nothing to hide')
  assert.equal(staleAtStart(live, at('startup', by('other', live.key))), null, 'in flight: shown')
  assert.equal(staleAtStart(over, at('startup', null)), null, 'never delivered (ended with no session open): shown')
  assert.equal(staleAtStart(over, at('new', by('other', 'an|older'))), null, 'an older run was delivered, not this one: shown')
  assert.equal(staleAtStart(over, at('startup', by('other'))), over.key, 'already delivered: hidden')
  assert.equal(staleAtStart(over, at('resume', by('me'))), over.key, 'resumed, delivered before it closed: hidden')
  assert.equal(staleAtStart(over, at('reload', by('me'))), null, 'a reload keeps it when this session showed it')
  assert.equal(staleAtStart(over, at('reload', by('other'))), over.key, 'a reload keeps it hidden when this session hid it')
  assert.equal(staleAtStart(over, at('reload', by(null))), null, 'a marker that names no session: a reload shows it')
  assert.equal(staleAtStart(over, at('reload', { key: over.key, sessions: ['other', 'me'] })), null, 'two sessions showed it: a reload of either shows it')
})

test('delivered marker: each session records its own; a run is delivered when any session showed it', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'dv-')), 'myapp-ci.ndjson')
  const first = '2025-01-01T00:00:00Z|42'
  assert.equal(readDelivered(file, first), null)
  markDelivered(file, first, 'me')
  assert.deepEqual(readDelivered(file, first), { key: first, sessions: ['me'] })
  markDelivered(file, first, 'other')
  markDelivered(file, first, 'me')
  assert.deepEqual(readDelivered(file, first).sessions.sort(), ['me', 'other'], 'sessions add up, once each')
  markDelivered(file, '2025-01-02T00:00:00Z|43', 'other')
  assert.deepEqual(readDelivered(file, '2025-01-02T00:00:00Z|43'), { key: '2025-01-02T00:00:00Z|43', sessions: ['other'] })
  assert.deepEqual(readDelivered(file, first), { key: first, sessions: ['me'] }, 'a session’s own file holds its last run')
  assert.equal(readdirSync(`${file}.delivered.d`).length, 2, 'one file per session')
  assert.equal(readDelivered(join(tmpdir(), 'no-such-dir-ci-local', 'x.ndjson'), first), null)
  markDelivered(join(tmpdir(), 'no-such-dir-ci-local', 'x.ndjson'), 'k', 'me') // no directory: ignored, never thrown
})

test('delivered marker: a 0.5.1 marker (the key alone) still reads, naming no session', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'dv-')), 'myapp-ci.ndjson')
  writeFileSync(`${file}.delivered`, '2025-01-03T00:00:00Z|44\n')
  assert.deepEqual(readDelivered(file, '2025-01-03T00:00:00Z|44'), { key: '2025-01-03T00:00:00Z|44', sessions: [] })
  assert.equal(readDelivered(file, 'another|1'), null)
  markDelivered(file, '2025-01-03T00:00:00Z|44', 'me')
  assert.deepEqual(readDelivered(file, '2025-01-03T00:00:00Z|44'), { key: '2025-01-03T00:00:00Z|44', sessions: ['me'] })
})

test('delivered marker: a session’s file unused for 30 days is removed when a session records', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'dv-')), 'myapp-ci.ndjson')
  markDelivered(file, 'old|1', 'gone')
  const old = new Date(Date.now() - 31 * 24 * 3600 * 1000)
  for (const name of readdirSync(`${file}.delivered.d`)) utimesSync(join(`${file}.delivered.d`, name), old, old)
  markDelivered(file, 'new|2', 'me')
  assert.equal(readDelivered(file, 'old|1'), null)
  assert.deepEqual(readDelivered(file, 'new|2'), { key: 'new|2', sessions: ['me'] })
})

test('status line: what each session shows, across sessions of one repository, with reloads', () => {
  const file = eventsFile([run({ pid: deadPid() }), { ts: ago(1000), event: 'end', result: 'passed', durationMs: 1000 }])
  const read = () => readRun(file)
  const open = (sessionId, reason = 'startup') => createStatusLine({ file, sessionId, reason })

  const a = open('a')
  assert.match(a.update(read()).footer, /passed/, 'ended with no session open: undelivered, shown')
  const b = open('b', 'new')
  assert.equal(b.update(read()).footer, undefined, 'delivered by a: a new session leaves it out')
  assert.equal(open('b', 'reload').update(read()).footer, undefined, 'b had it out: a reload keeps it out')
  assert.match(open('a', 'reload').update(read()).footer, /passed/, 'a showed it: a reload keeps it')
  assert.equal(open('a', 'resume').update(read()).footer, undefined, 'resumed later: already read')

  // A new run, seen by both open sessions: each shows it and records it.
  writeFileSync(file, JSON.stringify(run({ ts: ago(5000) })) + '\n')
  assert.match(a.update(read()).footer, /running/)
  assert.match(b.update(read()).footer, /running/, 'a run in flight shows everywhere')
  writeFileSync(file, [run({ ts: ago(5000), pid: deadPid() }), { ts: ago(1), event: 'end', result: 'failed', durationMs: 4000 }].map((e) => JSON.stringify(e)).join('\n') + '\n')
  assert.match(a.update(read()).footer, /failed/)
  assert.match(b.update(read()).footer, /failed/)
  assert.deepEqual(readDelivered(file, read().key).sessions.sort(), ['a', 'b'], 'both recorded, neither lost')
  assert.match(open('a', 'reload').update(read()).footer, /failed/)
  assert.match(open('b', 'reload').update(read()).footer, /failed/)
  assert.equal(open('c').update(read()).footer, undefined)
})

test('status line: update says when the footer changed, and records a finished run once', () => {
  const file = eventsFile([run({ pid: deadPid() }), { ts: ago(1000), event: 'end', result: 'passed', durationMs: 1000 }])
  const line = createStatusLine({ file, sessionId: 'a', reason: 'startup' })
  assert.equal(line.update(readRun(file)).changed, true)
  assert.equal(line.update(readRun(file)).changed, false)
  assert.equal(line.update(null).changed, true, 'no run any more: the footer is cleared')
})

// ---------------------------------------------------------------- ci_local_run

/** A repository whose own ci-local (node_modules/.bin) is `script`, a bash body. */
function repoWithCiLocal(script) {
  const dir = repo('CI_PROJECT="myapp-ci"\n')
  return { dir, bin: fakeCiLocal(dir, script), file: join(dir, 'events.ndjson') }
}

/**
 * The exit of a launch. Its child is unref'd (Pi must not wait on it), so
 * awaiting it alone leaves the event loop empty: Node 22's runner then
 * cancels the test. A timer holds the loop meanwhile.
 */
async function exitOf(launch) {
  const hold = setInterval(() => {}, 1000)
  try {
    return await launch.exited
  } finally {
    clearInterval(hold)
  }
}

/** A bash line that writes this process's queued event to $EVENTS_FILE. */
const QUEUED = `printf '{"ts":"%s","event":"queued","project":"myapp-ci","pid":%s,"session":"s","ahead":1,"blockedBy":{"project":"erp-ci","pid":1}}\\n' "$(date -u +%FT%TZ)" $$ >"$EVENTS_FILE"`

test('ciLocalBin: the repository\'s own ci-local, else the one on PATH', () => {
  const { dir, bin } = repoWithCiLocal('exit 0')
  assert.equal(ciLocalBin(dir), bin)
  assert.equal(ciLocalBin(repo('CI_PROJECT=x\n')), 'ci-local')
})

test('launchRun: detached, in the repository, with the session named and the output in a file', async () => {
  const { dir } = repoWithCiLocal('echo "cwd=$PWD session=$PI_SESSION_ID args=$*"; exit 0')
  const launch = launchRun({ repo: dir, args: ['--only', 'lint'], sessionId: 's-1' })
  assert.equal(typeof launch.pid, 'number')
  assert.equal((await exitOf(launch)).code, 0)
  const { readFileSync, realpathSync } = await import('node:fs')
  assert.equal(readFileSync(launch.output, 'utf8').trim(), `cwd=${realpathSync(dir)} session=s-1 args=--only lint`)
})

test('launchRun: a ci-local that cannot start is an error, not a run', async () => {
  const dir = repo('CI_PROJECT="myapp-ci"\n')
  const launch = launchRun({ repo: dir, sessionId: 's', bin: join(dir, 'missing-ci-local') })
  await exitOf(launch)
  assert.equal(launch.ended, true)
  assert.equal(launch.code, null)
  assert.match(launch.error, /ENOENT/)
})

test('waitForStart: the run once its first event names its pid', async () => {
  const { dir, file } = repoWithCiLocal(`${QUEUED}; sleep 5`)
  const launch = launchRun({ repo: dir, sessionId: 's', env: { ...process.env, EVENTS_FILE: file } })
  try {
    const result = await waitForStart(launch, file, { timeoutMs: 4000, pollMs: 20 })
    assert.equal(result.kind, 'started')
    assert.equal(result.run.state.state, 'queued')
    assert.match(launchReport(result, launch, 'myapp-ci'), /^ci-local started \(pid \d+\) for myapp-ci: queued · 1 ahead \(erp-ci running\)\./)
  } finally {
    process.kill(launch.pid)
  }
})

test('waitForStart: a run that wrote its events and ended between two looks started, it did not fail to', async () => {
  const { dir, file } = repoWithCiLocal(`${QUEUED}; exit 1`)
  const launch = launchRun({ repo: dir, sessionId: 's', env: { ...process.env, EVENTS_FILE: file } })
  await exitOf(launch)
  const result = await waitForStart(launch, file, { timeoutMs: 1000, pollMs: 20 })
  assert.equal(result.kind, 'started')
})

test('launchRun: a spawn that throws leaves no output directory behind', () => {
  const dir = repo('CI_PROJECT="myapp-ci"\n')
  const before = readdirSync(tmpdir()).filter((name) => name.startsWith('ci-local-run-')).length
  assert.throws(() => launchRun({ repo: dir, sessionId: 's', args: ['bad\0arg'] }))
  assert.equal(readdirSync(tmpdir()).filter((name) => name.startsWith('ci-local-run-')).length, before)
})

test('waitForStart: an aborted wait stops waiting and leaves the run alone', async () => {
  const { dir, file } = repoWithCiLocal('sleep 5')
  const launch = launchRun({ repo: dir, sessionId: 's' })
  try {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const began = performance.now()
    const result = await waitForStart(launch, file, { timeoutMs: 4000, pollMs: 20, signal: controller.signal })
    assert.ok(performance.now() - began < 1000, 'not the whole timeout')
    assert.equal(result.kind, 'waiting')
    assert.equal(launch.ended, false, 'still running')
  } finally {
    process.kill(launch.pid)
  }
})

test('outputTail: only the end of a large output is read', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'tail-')), 'output.log')
  writeFileSync(file, 'x'.repeat(1_000_000) + '\nlast one\nlast two\n')
  assert.deepEqual(outputTail(file, 2), ['last one', 'last two'])
})

test('pruneLaunchOutputs: removes launch outputs older than the age given, and nothing else', () => {
  const base = mkdtempSync(join(tmpdir(), 'prune-'))
  const old = join(base, 'ci-local-run-old')
  const fresh = join(base, 'ci-local-run-new')
  const other = join(base, 'something-else')
  for (const dir of [old, fresh, other]) {
    mkdirSync(dir)
    writeFileSync(join(dir, 'output.log'), 'x')
  }
  const longAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000)
  utimesSync(old, longAgo, longAgo)
  utimesSync(other, longAgo, longAgo)
  pruneLaunchOutputs({ dir: base, maxAgeMs: 7 * 24 * 3600 * 1000 })
  assert.deepEqual(readdirSync(base).sort(), ['ci-local-run-new', 'something-else'])
})

test('waitForStart: an exit before any event says so, with the output', async () => {
  const { dir, file } = repoWithCiLocal('echo "ci-local: unknown option --nope" >&2; exit 2')
  const launch = launchRun({ repo: dir, sessionId: 's' })
  const result = await waitForStart(launch, file, { timeoutMs: 4000, pollMs: 20 })
  assert.equal(result.kind, 'exited')
  const report = launchReport(result, launch, 'myapp-ci')
  assert.match(report, /^ci-local exited with status 2 before a run started/)
  assert.match(report, /unknown option --nope/)
})

test('waitForStart: still no event at the deadline is a run waiting for the events file', async () => {
  const { dir, file } = repoWithCiLocal('sleep 5')
  const launch = launchRun({ repo: dir, sessionId: 's' })
  try {
    const result = await waitForStart(launch, file, { timeoutMs: 100, pollMs: 20 })
    assert.equal(result.kind, 'waiting')
    assert.match(launchReport(result, launch, 'myapp-ci'), /^ci-local launched \(pid \d+\) for myapp-ci, no event yet/)
  } finally {
    process.kill(launch.pid)
  }
})

test('exitCard: a launch that ended before any event, as a failed card with the output tail', () => {
  const card = exitCard({ pid: 42, code: 2, output: '/tmp/x/output.log', tail: ['a', 'b'] })
  assert.equal(card.key, 'launch:42')
  assert.equal(card.state.state, 'failed')
  assert.equal(card.state.pid, 42)
  assert.match(card.block.lines[0], /✗ \*\*ci-local\*\* · ended before this session saw its run$/)
  assert.deepEqual(card.block.lines.slice(-2), ['> a', '> b'])
  // Status 0: its run passed (or it had nothing to run), not a failure.
  const passed = exitCard({ pid: 43, code: 0, output: '/tmp/y/output.log', tail: [] })
  assert.equal(passed.state.state, 'passed')
  assert.match(passed.block.lines[0], /✓ \*\*ci-local\*\* · ended before this session saw its run$/)
  // Killed by a signal: said so, not as a status.
  const killed = exitCard({ pid: 44, code: null, signal: 'SIGTERM', output: '/tmp/z/output.log', tail: [] })
  assert.equal(killed.state.state, 'failed')
  assert.match(killed.block.lines[1], /^> killed by SIGTERM · pid 44 · /)
})

test('launchRun: a launch killed by a signal records the signal, not a status', async () => {
  const { dir } = repoWithCiLocal('sleep 5')
  const launch = launchRun({ repo: dir, sessionId: 's' })
  process.kill(launch.pid, 'SIGTERM')
  const ended = await exitOf(launch)
  assert.equal(ended.code, null)
  assert.equal(ended.signal, 'SIGTERM')
  assert.match(launchReport({ kind: 'exited' }, launch, 'myapp-ci'), /^ci-local was killed by SIGTERM before a run started\./)
})

test('launchReport: a launch killed by a signal before its run says so', () => {
  const report = launchReport({ kind: 'exited' }, { pid: 5, code: null, signal: 'SIGKILL', output: '/nonexistent/output.log' }, 'myapp-ci')
  assert.match(report, /^ci-local was killed by SIGKILL before a run started\./)
})
