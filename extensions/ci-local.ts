// Pi extension for @jals1212/ci-local: the state of this repository's
// ci-local run in Pi's own UI, so neither the agent nor you write it by hand.
//
// - Footer: `🐳 ci-local [3/8] lint · 2m05s`, `⏳ queued · behind erp-ci`,
//   then `✅ passed · 4m12s` / `❌ failed at lint` until the next run.
// - When a run this session saw in flight ends: a notification and a card in
//   the transcript (the --status block). The card reaches the agent: as a
//   follow-up when it is busy (it reacts), with your next message when idle
//   (no turn is spent).
// - Tool `ci_local_status`: the same three lines, for the agent, without bash.
//
// It reads the events file each run writes (see README, "Following a run");
// it never runs ci-local or Docker. The logic lives in ./core.js.

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Box, Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'

import { createTracker, eventsFileFor, findProject, footerText, readRun } from './core.js'

const KEY = 'ci-local'
const POLL_MS = 1000

type Card = { state: string; lines: string[] }

export default function ciLocal(pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined

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
        const text = `No events file to follow for ${found.project}: the TMPDIR fallback cache is not a private directory of this user.`
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
    if (!ctx.hasUI) return
    const found = findProject(ctx.cwd)
    if (!found) return
    const file = eventsFileFor(found.project, process.env, found.repo)
    if (!file) return // no private cache: runs write no events here
    const tracker = createTracker()
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
      if (!tracker.observe(run)) return
      const state = run.state.state
      ctx.ui.notify(
        `ci-local ${state} · ${found.project}`,
        state === 'passed' ? 'info' : state === 'failed' ? 'error' : 'warning'
      )
      const card = { customType: KEY, content: run.block.lines.join('\n'), display: true, details: { state, lines: run.block.lines } }
      // Idle: appended and shown now, in the context of the next turn, no turn
      // spent ('nextTurn' would hide it until then). Busy: a follow-up the
      // agent handles when its current work settles.
      if (ctx.isIdle()) pi.sendMessage(card)
      else pi.sendMessage(card, { deliverAs: 'followUp' })
    }

    tick()
    timer = setInterval(tick, POLL_MS)
    timer.unref?.()
  })

  pi.on('session_shutdown', async () => stop())
}
