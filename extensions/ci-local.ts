// Pi extension for @jals1212/ci-local: the state of this repository's
// ci-local run in Pi's own UI, so neither the agent nor you write it by hand.
//
// - Footer: `🐳 ci-local [3/8] lint · 2m05s`, `⏳ queued · behind erp-ci`,
//   then `✅ passed · 4m12s` / `❌ failed at lint` until the next run.
// - When a run starts: a card in the transcript, for you only (a session
//   entry, never in the model's context).
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

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Box, Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'

import {
  WAKE_TEXT,
  cardContent,
  createDelivery,
  createTracker,
  deliveryOptions,
  eventsFileFor,
  findProject,
  footerText,
  readRun,
} from './core.js'

const KEY = 'ci-local'
/** The start card: a session entry, drawn in the transcript, never sent to the model. */
const START_KEY = 'ci-local-start'
/** The hidden wake message (see createDelivery). */
const WAKE_KEY = 'ci-local-wake'
const POLL_MS = 1000

type Card = { state: string; lines: string[] }

export default function ciLocal(pi: ExtensionAPI) {
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

  pi.registerEntryRenderer<{ lines: string[] }>(START_KEY, (entry, _options, theme) => {
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

  pi.on('session_start', async (_event, ctx: ExtensionContext) => {
    stop()
    runActive = false
    if (!ctx.hasUI) return
    const found = findProject(ctx.cwd)
    if (!found) return
    const file = eventsFileFor(found.project, process.env, found.repo)
    if (!file) return // CI_LOCAL_EVENTS=off, or no private cache: runs write no events
    const tracker = createTracker()
    const ends = createDelivery()
    delivery = ends
    let shown: string | undefined

    const tick = () => {
      let run
      try {
        run = readRun(file)
      } catch {
        return // a half-written file: the next tick reads it whole
      }
      const footer = run ? footerText(run.state) : undefined
      if (footer !== shown) {
        ctx.ui.setStatus(KEY, footer)
        shown = footer
      }
      if (tracker.started(run)) {
        try {
          pi.appendEntry(START_KEY, { lines: run.block.lines })
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

  pi.on('session_shutdown', async () => stop())
}
