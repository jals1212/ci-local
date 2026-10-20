// The Pi extension itself (extensions/ci-local.ts), loaded with a stand-in Pi:
// that its session_start wires the status line to createStatusLine across
// sessions of one repository, and that the glue around core.js does its job:
// one notification and one end card per run seen in flight, the delivery
// options for an idle agent and for one in a run, start cards, a run of
// another session, the renderers and the ci_local_status tool. The polling
// timer runs on node:test's mock timers, so a test ticks it by hand. Node runs
// the .ts by stripping its types, which Node 20 cannot do: there the tests are
// skipped (core.js is tested anyway).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock, test } from 'node:test'

import { CARD_GRACE_MS, WAKE_TEXT } from '../extensions/core.js'
import { fakeCiLocal } from './fixture/fake-ci-local.js'

const canRunTs = Boolean(process.features?.typescript)

const deadPid = () => Number(spawnSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim())
const ago = (ms) => new Date(Date.now() - ms).toISOString()

/** A stand-in Pi: what the extension registers, and what it shows and sends. */
function fakePi() {
  const pi = { handlers: {}, tools: {}, renderers: {}, entries: [], messages: [] }
  pi.api = {
    on: (name, fn) => (pi.handlers[name] = fn),
    registerTool: (tool) => (pi.tools[tool.name] = tool),
    registerEntryRenderer: (key, fn) => (pi.renderers[key] = fn),
    registerMessageRenderer: (key, fn) => (pi.renderers[key] = fn),
    appendEntry: (customType, data) => pi.entries.push({ customType, data }),
    sendMessage: (message, options) => pi.messages.push({ message, options }),
  }
  return pi
}

/** The extension, loaded once the way Pi loads it: the .ts itself, its Pi imports stubbed. */
async function loadExtension() {
  register(new URL('./fixture/pi-stubs/hooks.mjs', import.meta.url))
  return (await import('../extensions/ci-local.ts')).default
}

/** What the package leaves behind while it is loaded, for a CLI 0.7.x bridge (see FLAG in ci-local.ts). */
const PACKAGE_FLAG = Symbol.for('@jals1212/ci-local-pi')

/** A session of the extension: its Pi, its context, and what the user sees. */
async function openSession(extension, { repo, sessionId, reason = 'startup', branch = [], start = true }) {
  const pi = fakePi()
  extension(pi.api)
  const session = { pi, statuses: [], notices: [], idle: true }
  session.ctx = {
    hasUI: true,
    cwd: repo,
    isIdle: () => session.idle,
    sessionManager: { getBranch: () => branch, getSessionId: () => sessionId },
    ui: { setStatus: (_key, text) => session.statuses.push(text), notify: (message, level) => session.notices.push({ message, level }) },
  }
  session.start = () => pi.handlers.session_start({ type: 'session_start', reason }, session.ctx)
  session.shutdown = () => pi.handlers.session_shutdown?.({}, session.ctx)
  if (start) await session.start()
  return session
}

/** A repository whose events file is `file`, as CI_LOCAL_EVENTS names it. */
function glueRepo(project) {
  const repo = mkdtempSync(join(tmpdir(), 'pi-glue-'))
  writeFileSync(join(repo, 'ci-local.config.sh'), `CI_PROJECT="${project}"\n`)
  return { repo, file: join(repo, 'events.ndjson') }
}

const record = (event, fields = {}) => ({ ts: new Date().toISOString(), event, ...fields })
const write = (file, events) => appendFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n')
/** The run of a project, in its first event, by a live process (this one) of `session`. */
const queuedBehind = (project, session) =>
  record('queued', { project, version: '0.5.2', pid: process.pid, commit: 'abc', args: [], logDir: null, session, ahead: 1, blockedBy: { project: 'other-ci', pid: 1 } })
const runEvent = (project, session) =>
  record('run', { project, jobs: ['a'], total: 2, version: '0.5.2', pid: process.pid, commit: 'abc', args: [], logDir: null, session })

/** Runs `body` with the polling timer on mock timers and CI_LOCAL_EVENTS set; `tick(n)` is n polls. */
async function withPolling(file, body) {
  const saved = process.env.CI_LOCAL_EVENTS
  process.env.CI_LOCAL_EVENTS = file
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() })
  try {
    await body((n = 1) => {
      for (let i = 0; i < n; i++) mock.timers.tick(1000)
    })
  } finally {
    mock.timers.reset()
    if (saved === undefined) delete process.env.CI_LOCAL_EVENTS
    else process.env.CI_LOCAL_EVENTS = saved
  }
}

const cards = (session) => session.pi.messages.filter(({ message }) => message.customType === 'ci-local')
const wakes = (session) => session.pi.messages.filter(({ message }) => message.customType === 'ci-local-wake')

const TS = { skip: !canRunTs && 'Node cannot run TypeScript here' }

test('the extension wires session_start to the status line: shown once delivered, then left out', TS, async () => {
  const extension = await loadExtension()
  const shown = async (options) => {
    const session = await openSession(extension, options)
    await session.shutdown()
    return session.statuses.at(-1)
  }

  const repo = mkdtempSync(join(tmpdir(), 'pi-wire-'))
  writeFileSync(join(repo, 'ci-local.config.sh'), 'CI_PROJECT="wire-ci"\n')
  const events = join(repo, 'events.ndjson')
  const run = { ts: ago(65_000), event: 'run', project: 'wire-ci', jobs: ['a'], total: 1, version: '0.5.2', pid: deadPid(), commit: 'abc', args: [], logDir: null }
  writeFileSync(events, [run, { ts: ago(1000), event: 'end', result: 'passed', durationMs: 1000 }].map((e) => JSON.stringify(e)).join('\n') + '\n')

  const saved = process.env.CI_LOCAL_EVENTS
  process.env.CI_LOCAL_EVENTS = events
  try {
    assert.match(await shown({ repo, sessionId: 'a', reason: 'startup' }), /ci-local · ✓ passed/, 'undelivered: shown')
    assert.equal(await shown({ repo, sessionId: 'b', reason: 'new' }), undefined, 'delivered by a: left out')
    assert.equal(await shown({ repo, sessionId: 'b', reason: 'reload' }), undefined, 'b’s reload keeps it out')
    assert.match(await shown({ repo, sessionId: 'a', reason: 'reload' }), /ci-local · ✓ passed/, 'a’s reload keeps it')
    assert.equal(await shown({ repo, sessionId: 'a', reason: 'resume' }), undefined, 'a resumed later: already read')
  } finally {
    if (saved === undefined) delete process.env.CI_LOCAL_EVENTS
    else process.env.CI_LOCAL_EVENTS = saved
  }
})

test('a run seen in flight then finished: one footer trail, one notification, one end card, delivered as an idle agent takes it', TS, async () => {
  const extension = await loadExtension()
  const { repo, file } = glueRepo('glue-ci')
  write(file, [queuedBehind('glue-ci', 'me')])

  await withPolling(file, async (tick) => {
    const me = await openSession(extension, { repo, sessionId: 'me' })
    assert.match(me.statuses.at(-1), /ci-local · ◌ queued · 1 ahead \(other-ci running\)/)
    assert.deepEqual(me.pi.entries.map(({ customType, data }) => [customType, data.phase]), [['ci-local-start', 'starting']], 'a start card when it waits for its turn')
    assert.match(me.pi.entries[0].data.lines[0], /queued/)

    write(file, [record('queued', { pid: process.pid, session: 'me', ahead: 0, blockedBy: null }), runEvent('glue-ci', 'me'), record('start', { step: 'lint', index: 1, total: 2, log: null })])
    tick()
    assert.match(me.statuses.at(-1), /ci-local · ⧗ \[1\/2\] lint/)
    assert.deepEqual(me.pi.entries.map(({ data }) => data.phase), ['starting', 'started'], 'another when its steps start')
    tick(3)
    assert.equal(me.pi.entries.length, 2, 'never repeated')
    assert.equal(me.notices.length, 0)
    assert.equal(me.pi.messages.length, 0, 'nothing for the agent while the run goes on')

    write(file, [record('ok', { step: 'lint', index: 1, total: 2 }), record('end', { result: 'passed', devStack: 'none', durationMs: 4000 })])
    tick()
    assert.match(me.statuses.at(-1), /ci-local · ✓ passed/)
    assert.deepEqual(me.notices, [{ message: 'ci-local passed · glue-ci', level: 'info' }])
    // An idle agent: the card is stored without a turn...
    assert.equal(cards(me).length, 1)
    const [{ message, options }] = cards(me)
    assert.deepEqual(options, { triggerTurn: false })
    assert.equal(message.display, true)
    assert.equal(message.details.state, 'passed')
    assert.ok(message.details.lines.every((line) => line.startsWith('> ')))
    assert.match(message.content, /^The ci-local Pi extension: a run of glue-ci you saw start has ended \(this is not a message from the user\)\.\n\n> 🚦 ✓ \*\*ci-local\*\* · passed\n/)
    assert.equal(wakes(me).length, 0, 'no wake while the run’s process is still there')

    // ...and one hidden wake follows, once the grace for the run's own exit notice has passed.
    tick(Math.ceil(CARD_GRACE_MS / 1000) + 1)
    assert.equal(wakes(me).length, 1)
    assert.deepEqual(wakes(me)[0], { message: { customType: 'ci-local-wake', content: WAKE_TEXT, display: false }, options: { deliverAs: 'steer', triggerTurn: true } })
    tick(5)
    assert.equal(me.notices.length, 1, 'exactly one notification per run')
    assert.equal(cards(me).length, 1, 'exactly one end card per run')
    assert.equal(wakes(me).length, 1, 'exactly one wake')
    assert.equal(me.pi.entries.length, 2)

    // The timer stops with the session.
    await me.shutdown()
    const shown = me.statuses.length
    write(file, [queuedBehind('glue-ci', 'me')])
    tick(2)
    assert.equal(me.statuses.length, shown)
  })
})

test('an agent in a run gets the end card steered in, with a turn, and no wake', TS, async () => {
  const extension = await loadExtension()
  const { repo, file } = glueRepo('glue-ci')
  write(file, [runEvent('glue-ci', 'me')])

  await withPolling(file, async (tick) => {
    const me = await openSession(extension, { repo, sessionId: 'me' })
    assert.deepEqual(me.pi.entries.map(({ data }) => data.phase), ['started'], 'first seen running: only the started card')
    await me.pi.handlers.agent_start({ type: 'agent_start' }, me.ctx)
    me.idle = false

    write(file, [record('end', { result: 'failed', devStack: 'none', durationMs: 4000 })])
    tick()
    assert.deepEqual(me.notices, [{ message: 'ci-local failed · glue-ci', level: 'error' }])
    assert.equal(me.pi.messages.length, 1)
    assert.equal(cards(me).length, 1)
    assert.deepEqual(cards(me)[0].options, { deliverAs: 'steer', triggerTurn: true })
    tick(Math.ceil(CARD_GRACE_MS / 1000) + 2)
    assert.equal(wakes(me).length, 0, 'the run carries the card: nothing to wake')
    assert.equal(me.pi.messages.length, 1)
  })
})

test('an agent busy without a run holds the card until it is idle', TS, async () => {
  const extension = await loadExtension()
  const { repo, file } = glueRepo('glue-ci')
  write(file, [runEvent('glue-ci', 'me')])

  await withPolling(file, async (tick) => {
    const me = await openSession(extension, { repo, sessionId: 'me' })
    me.idle = false // compacting: no agent run, not idle
    write(file, [record('end', { result: 'passed', devStack: 'none', durationMs: 4000 })])
    tick(3)
    assert.equal(me.notices.length, 1, 'the user is told at once')
    assert.equal(me.pi.messages.length, 0, 'the agent gets nothing yet')
    me.idle = true
    tick()
    assert.equal(cards(me).length, 1)
    assert.deepEqual(cards(me)[0].options, { triggerTurn: false })
  })
})

test('a start card the session already shows is not made again after a reload', TS, async () => {
  const extension = await loadExtension()
  const { repo, file } = glueRepo('glue-ci')
  write(file, [runEvent('glue-ci', 'me')])

  await withPolling(file, async (tick) => {
    const first = await openSession(extension, { repo, sessionId: 'me' })
    const [entry] = first.pi.entries
    await first.shutdown()
    const branch = [{ type: 'custom', customType: entry.customType, data: entry.data }]
    const again = await openSession(extension, { repo, sessionId: 'me', reason: 'reload', branch })
    tick(2)
    assert.deepEqual(again.pi.entries, [])
  })
})

test('a run of another session gets no card, no notification and no wake, but shows in the status line', TS, async () => {
  const extension = await loadExtension()
  const { repo, file } = glueRepo('glue-ci')
  write(file, [runEvent('glue-ci', 'someone-else'), record('start', { step: 'lint', index: 1, total: 2, log: null })])

  await withPolling(file, async (tick) => {
    const me = await openSession(extension, { repo, sessionId: 'me' })
    assert.match(me.statuses.at(-1), /ci-local · ⧗ \[1\/2\] lint/, 'in the status line')
    write(file, [record('ok', { step: 'lint', index: 1, total: 2 }), record('end', { result: 'passed', devStack: 'none', durationMs: 4000 })])
    tick()
    assert.match(me.statuses.at(-1), /ci-local · ✓ passed/)
    tick(Math.ceil(CARD_GRACE_MS / 1000) + 2)
    assert.deepEqual(me.pi.entries, [], 'no start card')
    assert.deepEqual(me.notices, [])
    assert.deepEqual(me.pi.messages, [])
  })
})

test('a run already over when the session starts is no news: no notification, no card', TS, async () => {
  const extension = await loadExtension()
  const { repo, file } = glueRepo('glue-ci')
  write(file, [{ ...runEvent('glue-ci', 'me'), pid: deadPid() }, record('end', { result: 'passed', devStack: 'none', durationMs: 4000 })])

  await withPolling(file, async (tick) => {
    const me = await openSession(extension, { repo, sessionId: 'me' })
    tick(3)
    assert.match(me.statuses.at(-1), /ci-local · ✓ passed/)
    assert.deepEqual([me.notices, me.pi.entries, me.pi.messages], [[], [], []])
  })
})

test('the end card and the start card are drawn from their lines', TS, async () => {
  const extension = await loadExtension()
  const { repo } = glueRepo('glue-ci')
  const theme = {
    fg: (color, text) => `<${color}>${text}</${color}>`,
    bold: (text) => `*${text}*`,
    bg: (_color, text) => text,
  }
  const lines = ['> 🚦 ✓ **ci-local** · passed', '> `ci-local` · project `glue-ci`', '> 2 steps · 4s']
  const drawn = ['<dim>`ci-local` · project `glue-ci`</dim>', '<dim>2 steps · 4s</dim>']
  const me = await openSession(extension, { repo, sessionId: 'me' })
  const textOf = (box) => box.children[0].text

  const end = me.pi.renderers['ci-local']({ details: { state: 'passed', lines }, content: 'ignored' }, { outputPad: 2 }, theme)
  assert.equal(end.args[0], 2)
  assert.equal(textOf(end), ['<success>*🚦 ✓ ci-local · passed*</success>', ...drawn].join('\n'))
  const failed = me.pi.renderers['ci-local']({ details: { state: 'failed', lines }, content: '' }, { outputPad: 1 }, theme)
  assert.match(textOf(failed), /^<error>/)
  const stopped = me.pi.renderers['ci-local']({ details: { state: 'stopped', lines }, content: '' }, { outputPad: 1 }, theme)
  assert.match(textOf(stopped), /^<warning>/)
  // Without details (a card from an older session) it reads the content.
  const plain = me.pi.renderers['ci-local']({ content: '> first\n> second' }, { outputPad: 1 }, theme)
  assert.equal(textOf(plain), '<warning>*first*</warning>\n<dim>second</dim>')

  const start = me.pi.renderers['ci-local-start']({ data: { lines } }, {}, theme)
  assert.equal(textOf(start), ['<accent>*🚦 ✓ ci-local · passed*</accent>', ...drawn].join('\n'))
})

test('the ci_local_status tool says the three lines of the last run, or why there are none', TS, async () => {
  const extension = await loadExtension()
  const { repo, file } = glueRepo('glue-ci')
  const me = await openSession(extension, { repo, sessionId: 'me' })
  const tool = me.pi.tools.ci_local_status
  assert.equal(tool.name, 'ci_local_status')
  const call = (cwd = repo) => tool.execute('call-1', {}, undefined, undefined, { cwd })

  await withPolling(file, async () => {
    const none = await call()
    assert.deepEqual(none, { content: [{ type: 'text', text: `No ci-local run recorded for glue-ci (${file}).` }], details: undefined })

    write(file, [{ ...runEvent('glue-ci', 'me'), pid: deadPid() }, record('start', { step: 'lint', index: 1, total: 2, log: null }), record('fail', { step: 'lint', index: 1, total: 2, exitCode: 2, log: '/tmp/lint.log' }), record('end', { result: 'failed', devStack: 'none', durationMs: 4000 })])
    const failed = await call()
    assert.equal(failed.content.length, 1)
    assert.equal(failed.content[0].type, 'text')
    const lines = failed.content[0].text.split('\n')
    assert.equal(lines.length, 3)
    assert.match(lines[0], /^> 🚦 ✗ \*\*ci-local\*\* · failed$/)
    assert.match(lines[2], /^> Failed at: lint \(step 1\/2, exit 2\) · 4s · log: `\/tmp\/lint\.log`\.$/)
    assert.deepEqual(failed.details, { state: 'failed' })

    await assert.rejects(call(tmpdir()), /no ci-local\.config\.sh with a literal CI_PROJECT at or above/)
  })

  // CI_LOCAL_EVENTS=off: no events file to follow, and the tool says so.
  const saved = process.env.CI_LOCAL_EVENTS
  process.env.CI_LOCAL_EVENTS = 'off'
  try {
    const off = await call()
    assert.match(off.content[0].text, /^No events file to follow for glue-ci: CI_LOCAL_EVENTS is off/)
  } finally {
    if (saved === undefined) delete process.env.CI_LOCAL_EVENTS
    else process.env.CI_LOCAL_EVENTS = saved
  }
})

/** glueRepo, with its own ci-local (node_modules/.bin) running `script`, a bash body. */
function glueRepoWithCiLocal(project, script) {
  const { repo, file } = glueRepo(project)
  fakeCiLocal(repo, script)
  return { repo, file }
}

/** Waits, in real time (the timers are mocked), until `check()` is true. */
async function until(check, ms = 5000) {
  const deadline = performance.now() + ms
  while (!check()) {
    if (performance.now() > deadline) assert.fail('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('ci_local_run starts the run detached, as this session\'s: the tool says it is queued, the footer and a start card follow it', TS, async () => {
  const extension = await loadExtension()
  const { repo, file } = glueRepoWithCiLocal(
    'glue-ci',
    `printf '{"ts":"%s","event":"queued","project":"glue-ci","pid":%s,"session":"%s","ahead":1,"blockedBy":{"project":"other-ci","pid":1}}\\n' "$(date -u +%FT%TZ)" $$ "$PI_SESSION_ID" >"$CI_LOCAL_EVENTS"; exec sleep 30`
  )
  await withPolling(file, async (tick) => {
    const me = await openSession(extension, { repo, sessionId: 'me' })
    const result = await me.pi.tools.ci_local_run.execute('call-1', { args: ['--only', 'lint'] }, undefined, undefined, me.ctx)
    try {
      assert.equal(result.details.kind, 'started')
      assert.match(result.content[0].text, /^ci-local started \(pid \d+\) for glue-ci: queued · 1 ahead \(other-ci running\)\./)
      tick()
      assert.match(me.statuses.at(-1), /ci-local · ◌ queued · 1 ahead \(other-ci running\)/)
      assert.deepEqual(me.pi.entries.map(({ data }) => data.phase), ['starting'], 'its own run: a start card')
      assert.deepEqual(wakes(me), [])
    } finally {
      process.kill(result.details.pid)
    }
  })
})

test('ci_local_run in a session started before the config existed: the footer and a start card follow its run (#51)', TS, async () => {
  const extension = await loadExtension()
  const repo = mkdtempSync(join(tmpdir(), 'pi-late-'))
  const file = join(repo, 'events.ndjson')
  await withPolling(file, async (tick) => {
    const me = await openSession(extension, { repo, sessionId: 'me' })
    writeFileSync(join(repo, 'ci-local.config.sh'), 'CI_PROJECT="late-ci"\n')
    fakeCiLocal(
      repo,
      `printf '{"ts":"%s","event":"queued","project":"late-ci","pid":%s,"session":"%s","ahead":1,"blockedBy":{"project":"other-ci","pid":1}}\\n' "$(date -u +%FT%TZ)" $$ "$PI_SESSION_ID" >"$CI_LOCAL_EVENTS"; exec sleep 30`
    )
    const result = await me.pi.tools.ci_local_run.execute('call-1', {}, undefined, undefined, me.ctx)
    try {
      assert.equal(result.details.kind, 'started')
      assert.match(result.content[0].text, /The footer follows it/)
      tick()
      assert.match(me.statuses.at(-1), /ci-local · ◌ queued/)
      assert.deepEqual(me.pi.entries.map(({ data }) => data.phase), ['starting'])
    } finally {
      process.kill(result.details.pid)
    }
  })
})

test('a config that appears after the session started is picked up at the end of a turn (#51)', TS, async () => {
  const extension = await loadExtension()
  const repo = mkdtempSync(join(tmpdir(), 'pi-late-'))
  const file = join(repo, 'events.ndjson')
  await withPolling(file, async (tick) => {
    const me = await openSession(extension, { repo, sessionId: 'me' })
    await me.pi.handlers.turn_end({ type: 'turn_end' }, me.ctx)
    tick()
    assert.deepEqual(me.statuses, [], 'no config yet: nothing to follow')
    writeFileSync(join(repo, 'ci-local.config.sh'), 'CI_PROJECT="late-ci"\n')
    write(file, [queuedBehind('late-ci', 'me')])
    await me.pi.handlers.turn_end({ type: 'turn_end' }, me.ctx)
    tick()
    assert.match(me.statuses.at(-1), /ci-local · ◌ queued/)
    assert.deepEqual(me.pi.entries.map(({ data }) => data.phase), ['starting'])
  })
})

test('ci_local_run with nothing to follow the run (no events file) does not promise a footer or an end card', TS, async () => {
  const { repo } = glueRepoWithCiLocal('glue-ci', 'exec sleep 30')
  const saved = process.env.CI_LOCAL_EVENTS
  process.env.CI_LOCAL_EVENTS = 'off'
  try {
    const { createCiLocalExtension } = await import('../extensions/ci-local.ts')
    const me = await openSession(createCiLocalExtension({ launchWaitMs: 0 }), { repo, sessionId: 'me' })
    const result = await me.pi.tools.ci_local_run.execute('call-1', {}, undefined, undefined, me.ctx)
    try {
      assert.equal(result.details.kind, 'waiting')
      assert.doesNotMatch(result.content[0].text, /The footer follows it/)
      assert.match(result.content[0].text, /ci_local_status/)
    } finally {
      process.kill(result.details.pid)
    }
  } finally {
    if (saved === undefined) delete process.env.CI_LOCAL_EVENTS
    else process.env.CI_LOCAL_EVENTS = saved
  }
})

test('ci_local_run: a launch that ends before any event, after the tool returned, gets a failed card and a wake', TS, async () => {
  const { createCiLocalExtension } = await import('../extensions/ci-local.ts')
  const extension = createCiLocalExtension({ launchWaitMs: 0 })
  const { repo, file } = glueRepoWithCiLocal('glue-ci', 'sleep 0.3; echo "ci-local: the config is broken" >&2; exit 2')
  await withPolling(file, async (tick) => {
    const me = await openSession(extension, { repo, sessionId: 'me' })
    const result = await me.pi.tools.ci_local_run.execute('call-1', {}, undefined, undefined, me.ctx)
    assert.equal(result.details.kind, 'waiting')
    assert.match(result.content[0].text, /no event yet/)
    await until(() => spawnSync('kill', ['-0', String(result.details.pid)]).status !== 0)
    tick()
    assert.deepEqual(me.notices, [{ message: 'ci-local ended before this session saw its run · glue-ci', level: 'error' }])
    assert.equal(cards(me).length, 1)
    const card = cards(me)[0]
    assert.equal(card.message.details.state, 'failed')
    assert.match(card.message.details.lines[0], /ended before this session saw its run/)
    assert.ok(card.message.details.lines.includes('> ci-local: the config is broken'))
    assert.deepEqual(card.options, { triggerTurn: false }, 'an idle agent: stored')
    tick(3)
    assert.equal(wakes(me).length, 1, 'then one wake')
    tick(5)
    assert.equal(cards(me).length, 1, 'never twice')
  })
})

test('ci_local_run: a launch of an earlier session gets no card in the next one', TS, async () => {
  const { createCiLocalExtension } = await import('../extensions/ci-local.ts')
  const extension = createCiLocalExtension({ launchWaitMs: 0 })
  const { repo, file } = glueRepoWithCiLocal('glue-ci', 'sleep 0.3; exit 2')
  await withPolling(file, async (tick) => {
    const me = await openSession(extension, { repo, sessionId: 'old' })
    const result = await me.pi.tools.ci_local_run.execute('call-1', {}, undefined, undefined, me.ctx)
    // The same extension, now in another session (a /new or a /resume).
    me.ctx.sessionManager = { getBranch: () => [], getSessionId: () => 'new' }
    await me.start()
    await until(() => spawnSync('kill', ['-0', String(result.details.pid)]).status !== 0)
    tick(5)
    assert.deepEqual(cards(me), [])
    assert.deepEqual(me.notices, [])
  })
})

test('ci_local_run: an exit while the tool waits is its result, with the output, and no card', TS, async () => {
  const extension = await loadExtension()
  const { repo, file } = glueRepoWithCiLocal('glue-ci', 'echo "ci-local: unknown option --nope" >&2; exit 2')
  await withPolling(file, async (tick) => {
    const me = await openSession(extension, { repo, sessionId: 'me' })
    const result = await me.pi.tools.ci_local_run.execute('call-1', { args: ['--nope'] }, undefined, undefined, me.ctx)
    assert.equal(result.details.kind, 'exited')
    assert.match(result.content[0].text, /^ci-local exited with status 2 before a run started[\s\S]*unknown option --nope/)
    tick(5)
    assert.deepEqual(cards(me), [])
    assert.deepEqual(me.notices, [])
  })
})

/** Runs `body` as a process where the package has not loaded (it leaves its flag when it does). */
async function withoutPackage(body) {
  delete globalThis[PACKAGE_FLAG]
  try {
    await body()
  } finally {
    delete globalThis[PACKAGE_FLAG]
  }
}

test('the package says it is loaded, and stops saying so when its session ends', TS, async () => {
  const extension = await loadExtension()
  const { repo } = glueRepo('glue-ci')
  await withoutPackage(async () => {
    const me = await openSession(extension, { repo, sessionId: 'me' })
    assert.equal(globalThis[PACKAGE_FLAG], true)
    await me.shutdown()
    assert.equal(globalThis[PACKAGE_FLAG], undefined, 'a reload without the package must not find it still there')
  })
})

test('the package alone says nothing about moving', TS, async () => {
  const extension = await loadExtension()
  const { repo } = glueRepo('glue-ci')
  await withoutPackage(async () => {
    const me = await openSession(extension, { repo, sessionId: 'me' })
    assert.deepEqual(me.notices, [])
  })
})
