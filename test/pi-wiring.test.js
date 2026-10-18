// The Pi extension itself (extensions/ci-local.ts), loaded with a stand-in Pi:
// that its session_start wires the status line to createStatusLine, across
// sessions of one repository. Node runs the .ts by stripping its types, which
// Node 20 cannot do: there the test is skipped (core.js is tested anyway).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const canRunTs = Boolean(process.features?.typescript)

const deadPid = () => Number(spawnSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim())
const ago = (ms) => new Date(Date.now() - ms).toISOString()

/** A stand-in Pi: the handlers the extension registers, and what it shows. */
function fakePi() {
  const handlers = {}
  return {
    handlers,
    api: {
      on: (name, fn) => (handlers[name] = fn),
      registerTool() {},
      registerEntryRenderer() {},
      registerMessageRenderer() {},
      appendEntry() {},
      sendMessage() {},
    },
  }
}

async function openSession(extension, { repo, sessionId, reason }) {
  const pi = fakePi()
  extension(pi.api)
  const statuses = []
  const ctx = {
    hasUI: true,
    cwd: repo,
    isIdle: () => true,
    sessionManager: { getBranch: () => [], getSessionId: () => sessionId },
    ui: { setStatus: (_key, text) => statuses.push(text), notify() {} },
  }
  await pi.handlers.session_start({ type: 'session_start', reason }, ctx)
  await pi.handlers.session_shutdown?.({}, ctx)
  return statuses.at(-1)
}

test('the extension wires session_start to the status line: shown once delivered, then left out', { skip: !canRunTs && 'Node cannot run TypeScript here' }, async () => {
  register(new URL('./fixture/pi-stubs/hooks.mjs', import.meta.url))
  const { default: extension } = await import('../extensions/ci-local.ts')

  const repo = mkdtempSync(join(tmpdir(), 'pi-wire-'))
  writeFileSync(join(repo, 'ci-local.config.sh'), 'CI_PROJECT="wire-ci"\n')
  const events = join(repo, 'events.ndjson')
  const run = { ts: ago(65_000), event: 'run', project: 'wire-ci', jobs: ['a'], total: 1, version: '0.5.2', pid: deadPid(), commit: 'abc', args: [], logDir: null }
  writeFileSync(events, [run, { ts: ago(1000), event: 'end', result: 'passed', durationMs: 1000 }].map((e) => JSON.stringify(e)).join('\n') + '\n')

  const saved = process.env.CI_LOCAL_EVENTS
  process.env.CI_LOCAL_EVENTS = events
  try {
    assert.match(await openSession(extension, { repo, sessionId: 'a', reason: 'startup' }), /ci-local passed/, 'undelivered: shown')
    assert.equal(await openSession(extension, { repo, sessionId: 'b', reason: 'new' }), undefined, 'delivered by a: left out')
    assert.equal(await openSession(extension, { repo, sessionId: 'b', reason: 'reload' }), undefined, 'b’s reload keeps it out')
    assert.match(await openSession(extension, { repo, sessionId: 'a', reason: 'reload' }), /ci-local passed/, 'a’s reload keeps it')
    assert.equal(await openSession(extension, { repo, sessionId: 'a', reason: 'resume' }), undefined, 'a resumed later: already read')
  } finally {
    if (saved === undefined) delete process.env.CI_LOCAL_EVENTS
    else process.env.CI_LOCAL_EVENTS = saved
  }
})
