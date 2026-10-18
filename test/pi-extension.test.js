// The Pi extension's logic (extensions/core.js): which events file a session
// follows, what the footer says, and when a run has just ended. The glue to
// Pi (extensions/ci-local.ts) only wires these to ctx.ui and pi.sendMessage.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { cardContent, createTracker, eventsFileFor, findProject, footerText, readRun } from '../extensions/core.js'

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
