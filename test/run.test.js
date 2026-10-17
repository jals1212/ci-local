// Running a plan, without a Docker daemon: test/fixture/fake-docker/docker
// stands in for the CLI and runs `docker exec` commands here. What is proven:
// how a step's output reaches the terminal (live by default, in a log file
// with --quiet), the --events file, and that the summary is the same in
// every mode.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../bin/ci-local', import.meta.url))
const FAKE_DOCKER = fileURLToPath(new URL('./fixture/fake-docker/', import.meta.url))
chmodSync(join(FAKE_DOCKER, 'docker'), 0o755)

/** A project directory with this plan (the body of ci_plan) and jobs. */
function project(plan, jobs = 'a b') {
  const dir = mkdtempSync(join(tmpdir(), 'ci-local-run-'))
  writeFileSync(join(dir, '.nvmrc'), '24.21.0\n')
  writeFileSync(
    join(dir, 'ci-local.config.sh'),
    ['CI_PROJECT=ci-local-selftest', `CI_JOBS=(${jobs})`, 'ci_plan() {', ...plan.map((line) => `  ${line}`), '}', ''].join('\n')
  )
  return dir
}

/**
 * Runs ci-local and records when each line of stdout arrived, in
 * milliseconds since the start.
 */
function ciLocal(args, { cwd, env = {} }) {
  let child
  const result = new Promise((resolve) => {
    const started = Date.now()
    const base = { ...process.env }
    delete base.CI_LOCAL_QUIET
    delete base.CI_LOCAL_EVENTS
    child = spawn('bash', [BIN, ...args], {
      cwd,
      env: {
        ...base,
        // The default events file goes under it: never the real ~/.cache.
        XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), 'ci-local-cache-')),
        PATH: `${FAKE_DOCKER}:${process.env.PATH}`,
        ...env,
      },
    })
    const lines = []
    let out = ''
    let err = ''
    let pending = ''
    child.stdout.on('data', (chunk) => {
      const at = Date.now() - started
      out += chunk
      pending += chunk
      const parts = pending.split('\n')
      pending = parts.pop()
      for (const text of parts) lines.push({ text, at })
    })
    child.stderr.on('data', (chunk) => (err += chunk))
    child.on('close', (status) => resolve({ status, out, err, lines }))
  })
  result.child = child
  return result
}

/** From the summary to the end, with durations made comparable. */
const summary = (out) =>
  out
    .slice(out.indexOf('ci-local summary:'))
    .replace(/\b\d+m\d{2}s\b|\b\d+s\b/g, '<t>')

/** Resolves when check() is true; fails after timeoutMs. */
async function until(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`still waiting after ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const arrival = (lines, text) => lines.find((line) => line.text === text)?.at

const readEvents = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))

test('a step’s output reaches the terminal line by line, while the step runs', async () => {
  const dir = project(["ci_step box Slow 'echo first-line; sleep 1.5; echo second-line'"])
  const { status, lines } = await ciLocal([], { cwd: dir })
  assert.equal(status, 0)
  const first = arrival(lines, 'first-line')
  const second = arrival(lines, 'second-line')
  assert.ok(first !== undefined && second !== undefined, 'both lines are printed')
  assert.ok(second - first >= 1000, `first-line came ${second - first}ms before second-line, not in one block at the end`)
  assert.ok(arrival(lines, '==> [1/1] Slow') <= first, 'the start milestone comes first')
})

test('the summary and its last lines are the same with --quiet, --events or neither', async () => {
  const plan = ["ci_step box One 'echo one'", "ci_step box Two --deviates 'on purpose' 'echo two'"]
  const plain = await ciLocal([], { cwd: project(plan) })
  const quiet = await ciLocal(['--quiet'], { cwd: project(plan) })
  const events = await ciLocal(['--events', join(mkdtempSync(join(tmpdir(), 'ev-')), 'e.ndjson')], {
    cwd: project(plan),
  })
  for (const run of [plain, quiet, events]) assert.equal(run.status, 0, run.err)
  assert.match(plain.out, /\nPASSED: every step ran and passed\. This is not the GitHub check\.\n/)
  assert.match(plain.out, /ci-local summary: node 24\.21\.0, project ci-local-selftest, jobs: a b\n/)
  assert.match(plain.out, /\n {2}DEVIATES Two: on purpose\nPASSED/)
  assert.match(plain.out, /\nRemoving project ci-local-selftest \(runner, services, network, node_modules volume\)\n$/)
  assert.equal(summary(quiet.out), summary(plain.out))
  assert.equal(summary(events.out), summary(plain.out))
})

test('--quiet writes each step’s output to its log and prints only the milestones', async () => {
  const dir = project(["ci_step box 'Say hello' 'echo hello-from-step; echo to-stderr >&2'", "ci_step box Second 'echo second'"])
  const { status, out, err } = await ciLocal(['--quiet'], { cwd: dir })
  assert.equal(status, 0, err)
  assert.doesNotMatch(out + err, /hello-from-step|to-stderr/)
  assert.match(out, /==> \[1\/2\] Say hello\n<== Say hello: ok \(\d+s\)\n/)
  const logs = out.match(/\nStep output: (.+)\n/)[1]
  assert.match(logs, /ci-local-selftest-logs\./)
  assert.deepEqual(readdirSync(logs).sort(), ['01-say-hello.log', '02-second.log'])
  assert.equal(readFileSync(join(logs, '01-say-hello.log'), 'utf8'), 'hello-from-step\nto-stderr\n')
})

test('--quiet prints the end of a failing step’s log, then the usual summary', async () => {
  const lines = Array.from({ length: 60 }, (_, i) => `echo line-${i + 1}`).join('; ')
  const dir = project([`ci_step box Breaks '${lines}; exit 3'`, "ci_step box Never 'echo never'"])
  const { status, out, err } = await ciLocal(['--quiet'], { cwd: dir })
  assert.equal(status, 1)
  assert.match(err, /<== Breaks: FAILED with exit code 3/)
  assert.match(err, /Last 40 lines of .*01-breaks\.log:\n {2}line-21\n/)
  assert.match(err, / {2}line-60\n/)
  assert.doesNotMatch(err, /line-20\n/)
  assert.match(out, /FAILED at step: Breaks\n/)
  assert.doesNotMatch(out, /never/)
})

test('--events writes one JSON object per milestone, in order, with --only and --skip', async () => {
  const dir = project([
    "ci_step box Setup 'true'",
    "ci_step box 'Job a' --job a 'true'",
    "ci_step box Audit --job a --tag audit 'true'",
    "ci_step box 'Job b' --job b 'true'",
  ])
  const file = join(mkdtempSync(join(tmpdir(), 'ev-')), 'events.ndjson')
  writeFileSync(file, '{"left":"from an earlier run"}\n')
  const { status, err } = await ciLocal(['--only', 'a', '--skip', 'audit', '--keep', '--events', file], { cwd: dir })
  assert.equal(status, 0, err)
  const events = readEvents(file)
  assert.deepEqual(
    events.map(({ event, step }) => [event, step ?? null]),
    [
      ['run', null],
      ['start', 'Setup'],
      ['ok', 'Setup'],
      ['start', 'Job a'],
      ['ok', 'Job a'],
      ['end', null],
    ]
  )
  const [run, start, ok] = events
  assert.deepEqual(Object.keys(run).sort(), [
    'args',
    'commit',
    'event',
    'jobs',
    'logDir',
    'pid',
    'project',
    'total',
    'ts',
    'version',
  ])
  assert.equal(run.project, 'ci-local-selftest')
  assert.deepEqual(run.args, ['--only', 'a', '--skip', 'audit', '--keep', '--events', file])
  assert.equal(run.commit, null, 'not a git checkout')
  assert.equal(run.logDir, null, 'not --quiet')
  assert.equal(typeof run.pid, 'number')
  assert.match(run.version, /^\d+\.\d+\.\d+$/)
  assert.deepEqual(run.jobs, ['a'])
  assert.equal(run.total, 2)
  assert.deepEqual(Object.keys(start).sort(), ['event', 'index', 'step', 'total', 'ts'])
  assert.deepEqual([start.index, start.total], [1, 2])
  assert.deepEqual(Object.keys(ok).sort(), ['durationMs', 'event', 'index', 'step', 'total', 'ts'])
  assert.equal(typeof ok.durationMs, 'number')
  assert.ok(ok.durationMs >= 0)
  const end = events.at(-1)
  assert.deepEqual(Object.keys(end).sort(), ['devStack', 'durationMs', 'event', 'result', 'ts'])
  assert.equal(end.result, 'passed')
  assert.equal(end.devStack, 'none', 'no compose container of this checkout')
  for (const event of events) assert.match(event.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  const times = events.map((event) => Date.parse(event.ts))
  assert.deepEqual(times, [...times].sort((x, y) => x - y))
})

test('--events marks the failing step, its exit code and a failed end', async () => {
  const dir = project(["ci_step box Breaks 'exit 4'", "ci_step box Never 'true'"])
  const file = join(mkdtempSync(join(tmpdir(), 'ev-')), 'events.ndjson')
  const { status } = await ciLocal(['--events', file], { cwd: dir })
  assert.equal(status, 1)
  const events = readEvents(file)
  assert.deepEqual(
    events.map(({ event, step }) => [event, step ?? null]),
    [
      ['run', null],
      ['start', 'Breaks'],
      ['fail', 'Breaks'],
      ['end', null],
    ]
  )
  assert.equal(events[2].exitCode, 4)
  assert.equal(typeof events[2].durationMs, 'number')
  assert.equal(events[3].result, 'failed')
})

test('CI_LOCAL_QUIET and CI_LOCAL_EVENTS do what the options do; a relative path is the caller’s', async () => {
  const dir = project(["ci_step box Talks 'echo talking'"])
  mkdirSync(join(dir, 'sub'))
  const { status, out } = await ciLocal([], {
    cwd: join(dir, 'sub'),
    env: { CI_LOCAL_QUIET: '1', CI_LOCAL_EVENTS: 'events.ndjson' },
  })
  assert.equal(status, 0)
  assert.doesNotMatch(out, /\ntalking\n/)
  assert.deepEqual(
    readEvents(join(dir, 'sub', 'events.ndjson')).map((event) => event.event),
    ['run', 'start', 'ok', 'end']
  )
})

test('an interrupted step: the summary still reaches the terminal, and the events say so', async () => {
  for (const args of [[], ['--quiet']]) {
    const dir = project(["ci_step box Slow 'echo started; sleep 30'"])
    const file = join(dir, 'events.ndjson')
    const pids = join(dir, 'pids')
    const run = ciLocal([...args, '--events', file], { cwd: dir, env: { FAKE_DOCKER_PIDS: pids } })
    // Interrupt once the step's process exists (the fake docker recorded its
    // pid, so the cleanup's `docker rm` ends it), not after a fixed delay a
    // slow machine may not meet.
    await until(() => existsSync(pids) && readFileSync(pids, 'utf8').trim() !== '')
    run.child.kill('SIGTERM')
    const { status, out, err } = await run
    assert.equal(status, 143, args.join(' '))
    assert.match(out, /\nFAILED at step: interrupted\n/, args.join(' '))
    assert.match(out, /\nRemoving project ci-local-selftest /, args.join(' '))
    if (args.length) assert.match(err, /Output of the interrupted step: .*01-slow\.log/)
    const events = readEvents(file)
    assert.deepEqual(
      events.map(({ event }) => event),
      ['run', 'start', 'fail', 'end']
    )
    assert.equal(events[2].exitCode, 143)
    assert.equal(events[3].result, 'interrupted')
  }
})

test('an --events file that cannot be written is a status 2, before any step runs', async () => {
  const dir = project(["ci_step box Marker 'touch ran-a-step'"])
  for (const file of [join(dir, 'no-such-dir', 'events.ndjson'), dir]) {
    const { status, err } = await ciLocal(['--events', file], { cwd: dir })
    assert.equal(status, 2, file)
    assert.match(err, /ci-local: cannot write the --events file /, file)
    assert.equal(existsSync(join(dir, 'ran-a-step')), false, file)
  }
})

test('--events and --quiet say so when the option runs no step, and write nothing', async () => {
  const dir = project(["ci_step box X 'true'"])
  const file = join(dir, 'events.ndjson')
  for (const mode of ['--list', '--print-plan', '--down']) {
    const { status, out, err } = await ciLocal([mode, '--events', file, '--quiet'], { cwd: dir })
    assert.equal(status, 0, mode)
    assert.match(err, new RegExp(`ci-local: --events is ignored with ${mode}: it runs no step\\n`), mode)
    assert.match(err, new RegExp(`ci-local: --quiet is ignored with ${mode}: it runs no step\\n`), mode)
    assert.equal(existsSync(file), false, mode)
    if (mode === '--print-plan') assert.equal(JSON.parse(out).project, 'ci-local-selftest')
  }
  // Set in the environment, they are a standing preference: no warning.
  const { status, err } = await ciLocal(['--list'], {
    cwd: dir,
    env: { CI_LOCAL_EVENTS: file, CI_LOCAL_QUIET: '1' },
  })
  assert.equal(status, 0)
  assert.equal(err, '')
  assert.equal(existsSync(file), false)
})

test('--events needs a file name', async () => {
  const { status, err } = await ciLocal(['--events', '--list'], { cwd: project(["ci_step box X 'true'"]) })
  assert.equal(status, 2)
  assert.match(err, /--events needs a file/)
})
