// Pi extension for @jals1212/ci-local: the state of this repository's
// ci-local run in Pi's own UI, so neither the agent nor you write it by hand.
//
// - Status line: `🚦 ci-local ⧗ [3/8] lint · 2m05s`, `🚦 ci-local ◌ queued ·
//   2 ahead (erp-ci running)`, then `🚦 ci-local ✓ passed · 4m12s` / `🚦 ci-local
//   ✗ failed at lint` until the next run (🚦 is ci-local's own emoji, see BRAND).
//   A run already over when a session starts is shown only if no session
//   showed its result yet, like a message not yet delivered (createStatusLine).
// - Cards and the agent: only for runs this session started, as Gentle AI's job
//   notices go only to the session that started the job: a run that names this
//   session (PI_SESSION_ID, from its bash tool), or, naming none, one whose
//   recorded ancestor pids (or, without them, whose live process tree) include
//   this session's process (a background job, even orphaned). Another
//   session's run in the same repository, or one started in a terminal, shows
//   in the status line alone.
// - When a run starts: a card in the transcript when it is starting (or
//   waiting for its turn), another when its steps start; for you only (session
//   entries, never in the model's context, never repeated after a reload).
// - When a run this session saw in flight ends: a notification at once, and a
//   card in the transcript (the --status block). It reaches the agent as
//   Gentle AI hands content to a parent: an idle agent gets it stored at once
//   and one hidden wake after the run's process has exited (a background
//   job's own exit notice wakes it first, and the card rides along); an agent
//   in a run gets it steered in; busy without a run (compacting), it waits. A
//   failed delivery is tried again, never dropped.
// - Tool `ci_local_status`: the same three lines, for the agent, without bash.
//
// It reads the events file each run writes (see README, "Following a run");
// it never runs ci-local or Docker. The logic lives in ./core.js.
//

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Box, Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'

import {
  WAKE_TEXT,
  cardContent,
  createDelivery,
  createStatusLine,
  createTracker,
  deliveryOptions,
  eventsFileFor,
  findProject,
  ownsRun,
  readRun,
} from './core.js'

const KEY = 'ci-local'
/** The start card: a session entry, drawn in the transcript, never sent to the model. */
const START_KEY = 'ci-local-start'
/** The hidden wake message (see createDelivery). */
const WAKE_KEY = 'ci-local-wake'
const POLL_MS = 1000
/**
 * Set on globalThis while this package is loaded. A CLI 0.7.x still installed in
 * Pi loads a bridge that steps aside when it sees this flag, so a user with both
 * sees every card once. The CLI 0.8.0 has no bridge; the flag stays for 0.7.x.
 */
const FLAG = Symbol.for('@jals1212/ci-local-pi')

type Card = { state: string; lines: string[] }
/** A start card: the run, its stage ('starting', then 'started'), the --status block. */
type StartCard = { key: string; phase: 'starting' | 'started'; lines: string[] }

export function createCiLocalExtension() {
  return (pi: ExtensionAPI) => ciLocal(pi)
}

function ciLocal(pi: ExtensionAPI) {
  // Said at load, before any session starts, so a CLI 0.7.x bridge can see it
  // whatever the load order; session_shutdown takes it back (a reload without
  // this package must not find it still there).
  ;(globalThis as Record<symbol, unknown>)[FLAG] = true

  let timer: ReturnType<typeof setInterval> | undefined
  // The session's end cards, and whether an agent run is under way: it spans
  // agent_start to agent_settled (in-run compaction and retries included).
  let delivery: ReturnType<typeof createDelivery> | undefined
  let runActive = false

  pi.on('agent_start', async () => {
    runActive = true
    delivery?.boundary()
  })
  pi.on('agent_settled', async () => {
    runActive = false
    delivery?.boundary()
  })
  pi.on('turn_end', async () => delivery?.boundary())
  pi.on('session_compact', async () => delivery?.boundary())
  pi.on('session_compact_failed', async () => delivery?.boundary())

  pi.registerEntryRenderer<StartCard>(START_KEY, (entry, _options, theme) => {
    const lines = (entry.data?.lines ?? []).map((line) => line.replace(/^> ?/, '').replaceAll('**', ''))
    const text = [theme.fg('accent', theme.bold(lines[0] ?? 'ci-local')), ...lines.slice(1).map((line) => theme.fg('dim', line))]
    const box = new Box(1, 1, (t: string) => theme.bg('customMessageBg', t))
    box.addChild(new Text(text.join('\n'), 0, 0))
    return box
  })

  pi.registerMessageRenderer<Card>(KEY, (message, { outputPad }, theme) => {
    const card = message.details
    const lines = (card?.lines ?? String(message.content).split('\n')).map((line) =>
      line.replace(/^> ?/, '').replaceAll('**', '')
    )
    const color = card?.state === 'passed' ? 'success' : card?.state === 'failed' ? 'error' : 'warning'
    const text = [theme.fg(color, theme.bold(lines[0] ?? '')), ...lines.slice(1).map((line) => theme.fg('dim', line))]
    const box = new Box(outputPad, 1, (t: string) => theme.bg('customMessageBg', t))
    box.addChild(new Text(text.join('\n'), 0, 0))
    return box
  })

  pi.registerTool({
    name: 'ci_local_status',
    label: 'ci-local status',
    description:
      "State of this repository's last ci-local run (queued, starting, running, passed, failed, stopped) " +
      'as three Markdown lines: the step under way, or the failing step with its exit code and log. ' +
      'Read-only; use it instead of reading run logs or running `ci-local --status`.',
    promptSnippet: 'ci_local_status: the state of the last ci-local run of this repository',
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const found = findProject(ctx.cwd)
      if (!found) throw new Error(`no ci-local.config.sh with a literal CI_PROJECT at or above ${ctx.cwd}`)
      const file = eventsFileFor(found.project, process.env, found.repo)
      if (!file) {
        const text = `No events file to follow for ${found.project}: CI_LOCAL_EVENTS is off, or the TMPDIR fallback cache is not a private directory of this user.`
        return { content: [{ type: 'text', text }], details: undefined }
      }
      const run = readRun(file)
      const text = run ? run.block.lines.join('\n') : `No ci-local run recorded for ${found.project} (${file}).`
      return { content: [{ type: 'text', text }], details: run ? { state: run.state.state } : undefined }
    },
  })

  function stop() {
    if (timer) clearInterval(timer)
    timer = undefined
  }

  pi.on('session_start', async (event, ctx: ExtensionContext) => {
    stop()
    runActive = false
    if (!ctx.hasUI) return
    const found = findProject(ctx.cwd)
    if (!found) return
    const file = eventsFileFor(found.project, process.env, found.repo)
    if (!file) return // CI_LOCAL_EVENTS=off, or no private cache: runs write no events
    const tracker = createTracker()
    // Start cards this session already shows (a reload, a resumed session): not again.
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === START_KEY) {
        const data = entry.data as StartCard | undefined
        if (data?.key && data.phase) tracker.remember(data.key, data.phase)
      }
    }
    const ends = createDelivery()
    delivery = ends

    // Whether each run seen in flight is this session's own (decided once: by the
    // session the run names, else by its process ancestry; see ownsRun).
    const sessionId = ctx.sessionManager.getSessionId()
    const owned = new Map<string, boolean>()
    const isOwn = (run: NonNullable<ReturnType<typeof readRun>>) => {
      if (!owned.has(run.key)) owned.set(run.key, ownsRun(run, { sessionId }))
      return owned.get(run.key)
    }

    // The status line leaves out a run already over whose result a session
    // already showed, and records each finished run it shows (see
    // createStatusLine in core.js).
    const statusLine = createStatusLine({ file, sessionId, reason: event.reason })

    const tick = () => {
      let run
      try {
        run = readRun(file)
      } catch {
        return // a half-written file: the next tick reads it whole
      }
      const { footer, changed } = statusLine.update(run)
      if (changed) ctx.ui.setStatus(KEY, footer)
      // Only this session's own runs get cards and reach the agent, as Gentle
      // AI's job notices go only to the session that started the job. Another
      // session's run in this repository shows in the status line alone. What
      // is owed for an earlier own run is delivered either way.
      if (run && isOwn(run)) {
        const phase = tracker.phase(run)
        if (phase) {
          try {
            pi.appendEntry<StartCard>(START_KEY, { key: run.key, phase, lines: run.block.lines })
          } catch {
            // A start card is for show: never a reason to stop following the run.
          }
        }
        if (tracker.observe(run)) {
          const state = run.state.state
          ctx.ui.notify(
            `ci-local ${state} · ${found.project}`,
            state === 'passed' ? 'info' : state === 'failed' ? 'error' : 'warning'
          )
          ends.ended(run)
        }
      }
      deliver()
    }

    // At most one delivery per tick: a failure is retried later (see createDelivery).
    const deliver = () => {
      let action
      try {
        action = ends.next({ idle: ctx.isIdle(), runActive })
      } catch {
        return // a stale context: the next session_start brings a live one
      }
      if (!action) return
      try {
        if (action.kind === 'wake') {
          pi.sendMessage({ customType: WAKE_KEY, content: WAKE_TEXT, display: false }, deliveryOptions(action))
        } else {
          const ended = action.run
          const card = {
            customType: KEY,
            content: cardContent(ended.block, found.project),
            display: true,
            details: { state: ended.state.state, lines: ended.block.lines },
          }
          pi.sendMessage(card, deliveryOptions(action))
        }
        ends.done(action)
      } catch {
        ends.failed(action) // never lost: tried again first
      }
    }

    tick()
    timer = setInterval(tick, POLL_MS)
    timer.unref?.()
  })

  pi.on('session_shutdown', async () => {
    stop()
    delete (globalThis as Record<symbol, unknown>)[FLAG]
  })
}

export default createCiLocalExtension()
