// The command line of bin/ci-local: what it answers before Docker is touched.
// Only options that start nothing run here (--list, --print-plan, --help,
// --version and the refusals); the steps themselves are proven by running
// ci-local in a project.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../bin/ci-local', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./fixture/', import.meta.url))
const FAKE_DOCKER = join(FIXTURE, 'fake-docker')
chmodSync(join(FAKE_DOCKER, 'docker'), 0o755)

function ciLocal(args, { cwd = FIXTURE, env = {} } = {}) {
  // Cache and queue in fresh directories: never the real ones.
  const scratch = { XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), 'ci-local-cache-')), CI_LOCAL_QUEUE_DIR: mkdtempSync(join(tmpdir(), 'ci-local-queue-')) }
  const result = spawnSync('bash', [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...scratch, ...env } })
  return { status: result.status, out: result.stdout, err: result.stderr }
}

const listed = (out) => out.trim().split('\n').map((line) => line.replace(/^\s*\d+\. /, ''))

/** A project directory holding only this config and an .nvmrc. */
function project(config) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-local-'))
  writeFileSync(join(dir, '.nvmrc'), '24.21.0\n')
  writeFileSync(join(dir, 'ci-local.config.sh'), config)
  return dir
}

test('is valid bash', () => {
  assert.equal(spawnSync('bash', ['-n', BIN]).status, 0)
})

test('--version prints the package version', async () => {
  const { version } = JSON.parse(
    await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8')
  )
  assert.equal(ciLocal(['--version']).out.trim(), `ci-local ${version}`)
})

test('--list names every step, in the plan order', () => {
  const { status, out } = ciLocal(['--list'])
  assert.equal(status, 0)
  assert.deepEqual(listed(out), [
    '[host] Build the runner image',
    '[host] Start the Linux runner',
    '[box] npm ci',
    '[box] Audit',
    '[box] npm run lint',
    '[host] Start the database',
    '[box] Create the database',
    '[box] npm test',
    '[box] npm run e2e',
  ])
})

test('--only keeps the steps of no job and those of the named jobs', () => {
  const { out } = ciLocal(['--only', 'tests', '--list'])
  assert.deepEqual(listed(out), [
    '[host] Build the runner image',
    '[host] Start the Linux runner',
    '[box] npm ci',
    '[host] Start the database',
    '[box] Create the database',
    '[box] npm test',
    '[box] npm run e2e',
  ])
})

test('--skip leaves out the tagged steps and nothing else', () => {
  const all = listed(ciLocal(['--list']).out)
  const skipped = listed(ciLocal(['--skip', 'audit', '--list']).out)
  assert.deepEqual(skipped, all.filter((step) => step !== '[box] Audit'))
})

test('refuses an unknown job, an unknown option and empty values with status 2', () => {
  for (const args of [['--only', 'nope'], ['--frobnicate'], ['--only', ''], ['--only='], ['--skip', '']]) {
    const { status, err } = ciLocal([...args, '--list'])
    assert.equal(status, 2, args.join(' '))
    assert.match(err, /ci-local: /)
  }
})

test('--help documents every option, with or without a config', () => {
  for (const cwd of [FIXTURE, tmpdir()]) {
    const { status, out } = ciLocal(['--help'], { cwd })
    assert.equal(status, 0)
    for (const option of ['--only', '--skip', '--keep', '--down', '--rebuild', '--list', '--print-plan', '--version', '--quiet', '--live', '--events', '--status']) {
      assert.match(out, new RegExp(`\\n  ${option}\\b`), option)
    }
    for (const text of ['--no-wait', 'CI_LOCAL_QUEUE=off', 'CI_LOCAL_QUEUE_DIR', '3 busy with --no-wait']) assert.ok(out.includes(text), text)
  }
})

test('--no-wait changes nothing for the options that run no step', () => {
  for (const args of [['--list'], ['--print-plan'], ['--only', 'tests', '--list']]) {
    assert.deepEqual(ciLocal([...args, '--no-wait']), ciLocal(args), args.join(' '))
  }
})

test('without a config it says so, with status 2', () => {
  const { status, err } = ciLocal(['--list'], { cwd: tmpdir() })
  assert.equal(status, 2)
  assert.match(err, /no ci-local.config.sh/)
})

test('a config error is a status 2, before anything runs', () => {
  const cases = {
    'unknown step option': 'CI_PROJECT=p\nCI_JOBS=(a)\nci_plan() { ci_step box x --nope "true"; }\n',
    'unknown job': 'CI_PROJECT=p\nCI_JOBS=(a)\nci_plan() { ci_step box x --job b "true"; }\n',
    'unknown env set': 'CI_PROJECT=p\nCI_JOBS=(a)\nci_plan() { ci_step box x --env none "true"; }\n',
    '--deviates without a reason': 'CI_PROJECT=p\nCI_JOBS=(a)\nci_plan() { ci_step box x --deviates "" "true"; }\n',
    'host step not a function': 'CI_PROJECT=p\nCI_JOBS=(a)\nci_plan() { ci_step host x nothing_here; }\n',
    'no ci_plan': 'CI_PROJECT=p\nCI_JOBS=(a)\n',
    'no jobs': 'CI_PROJECT=p\nci_plan() { :; }\n',
    'bad project name': 'CI_PROJECT="Bad Name"\nCI_JOBS=(a)\nci_plan() { :; }\n',
  }
  for (const [name, config] of Object.entries(cases)) {
    const { status } = ciLocal(['--list'], { cwd: project(config) })
    assert.equal(status, 2, name)
  }
})

test('.nvmrc must name an exact version', () => {
  const dir = project('CI_PROJECT=p\nCI_JOBS=(a)\nci_plan() { :; }\n')
  writeFileSync(join(dir, '.nvmrc'), '24\n')
  const { status, err } = ciLocal(['--list'], { cwd: dir })
  assert.equal(status, 2)
  assert.match(err, /exact version/)
})

test('--print-plan is the whole plan as JSON, whatever --only says', () => {
  const plan = JSON.parse(ciLocal(['--print-plan', '--only', 'quality']).out)
  assert.equal(plan.project, 'fixture-ci')
  assert.deepEqual(plan.jobs, ['quality', 'tests'])
  assert.equal(plan.steps.length, 9)
  assert.deepEqual(plan.notMirrored, [
    { name: 'Start the database', reason: 'start_database: on the private network, no published port' },
  ])
  const test = plan.steps.find((step) => step.name === 'npm test')
  assert.deepEqual(test.env, ['NODE_ENV=test', 'DB_HOST=db', 'EXTRA=1'])
  assert.deepEqual(test.jobs, ['tests'])
  assert.equal(test.deviates, null)
  assert.equal(
    plan.steps.find((step) => step.name === 'npm run e2e').deviates,
    'leaves out the spec that needs the host network'
  )
  const audit = plan.steps.find((step) => step.name === 'Audit')
  assert.deepEqual(audit.pass, ['NPM_TOKEN'])
  assert.deepEqual(audit.tags, ['audit'])
  assert.equal(plan.steps.find((step) => step.name === 'npm run lint').timeout, 600)
  const database = plan.steps.find((step) => step.name === 'Start the database')
  assert.equal(database.kind, 'host')
  assert.deepEqual(database.args, ['postgres:17', 'pg_isready -U postgres'])
  assert.equal(database.command, 'start_database postgres:17 pg_isready\\ -U\\ postgres')
  assert.match(database.source, /^start_database \(\)/)
})

const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}']).status === 0

test('a host step stops at its first failing command', { skip: !docker && 'no Docker daemon' }, () => {
  const dir = project(
    [
      'CI_PROJECT=ci-local-selftest',
      'CI_JOBS=(a)',
      'fails_midway() { echo before; false; echo after-the-failure; }',
      'passes() { echo second-step; }',
      'ci_on_failure() { echo "diagnostics for: $1"; }',
      'ci_plan() {',
      '  ci_step host "Fails midway" fails_midway',
      '  ci_step host "Never runs" passes',
      '}',
      '',
    ].join('\n')
  )
  const { status, out, err } = ciLocal(['--live'], { cwd: dir })
  assert.equal(status, 1)
  assert.match(out, /before/)
  assert.doesNotMatch(out, /after-the-failure/)
  assert.doesNotMatch(out, /second-step/)
  assert.match(out, /FAILED at step: Fails midway/)
  assert.match(out, /diagnostics for: Fails midway/)
  assert.match(err, /Fails midway: FAILED with exit code 1/)
})

test('the summary names every step that ran with --deviates, and its reason', { skip: !docker && 'no Docker daemon' }, () => {
  const dir = project(
    [
      'CI_PROJECT=ci-local-selftest',
      'CI_JOBS=(a b)',
      'passes() { :; }',
      'ci_plan() {',
      '  ci_step host "Plain" passes',
      '  ci_step host "Narrower" --deviates "leaves out one spec" passes',
      '  ci_step host "Other job" --job b --deviates "never runs here" passes',
      '}',
      '',
    ].join('\n')
  )
  const { status, out } = ciLocal(['--only', 'a'], { cwd: dir })
  assert.equal(status, 0)
  assert.match(out, /\n {2}DEVIATES Narrower: leaves out one spec\nPASSED/)
  assert.doesNotMatch(out, /DEVIATES Plain|DEVIATES Other job/)
})

test('the runner is gone before ci_teardown runs', { skip: !docker && 'no Docker daemon' }, () => {
  const dir = project(
    [
      'CI_PROJECT=ci-local-selftest',
      'CI_JOBS=(a)',
      'fake_runner() { docker create --name ci-local-selftest-runner --label "$CI_LABEL" busybox true >/dev/null; }',
      'ci_teardown() {',
      '  if docker inspect ci-local-selftest-runner >/dev/null 2>&1; then echo "teardown: runner present"; else echo "teardown: runner gone"; fi',
      '}',
      'ci_plan() { ci_step host "Fake runner" fake_runner; }',
      '',
    ].join('\n')
  )
  const { status, out } = ciLocal([], { cwd: dir })
  assert.equal(status, 0)
  assert.match(out, /teardown: runner gone/)
  assert.doesNotMatch(out, /teardown: runner present/)
})

test('--print-plan carries the source of every function the config defines, and no engine function', () => {
  const plan = JSON.parse(ciLocal(['--print-plan']).out)
  assert.deepEqual(Object.keys(plan.functions), ['ci_plan', 'start_database'])
  assert.match(plan.functions.start_database, /^start_database \(\)/)
})

const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })

test('the run names the commit, uncommitted changes and visible ignored files', { skip: !docker && 'no Docker daemon' }, () => {
  const dir = project(
    ['CI_PROJECT=ci-local-selftest', 'CI_JOBS=(a)', 'passes() { :; }', 'ci_plan() { ci_step host "Plain" passes; }', ''].join('\n')
  )
  assert.match(ciLocal([], { cwd: dir }).out, /\n {2}checkout: not a git checkout\n/)

  git(dir, 'init', '-q')
  writeFileSync(join(dir, '.gitignore'), 'dist/\n.env\nnode_modules/\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'one')
  const sha = git(dir, 'rev-parse', '--short=12', 'HEAD').stdout.trim()
  assert.match(ciLocal([], { cwd: dir }).out, new RegExp(`\\n {2}checkout: commit ${sha}, clean\\n`))

  writeFileSync(join(dir, 'new.txt'), 'x')
  writeFileSync(join(dir, '.env'), 'SECRET=1')
  spawnSync('mkdir', ['-p', join(dir, 'dist'), join(dir, 'node_modules')])
  writeFileSync(join(dir, 'dist', 'a.js'), '')
  writeFileSync(join(dir, 'node_modules', 'b.js'), '')
  const { out } = ciLocal([], { cwd: dir })
  assert.match(out, new RegExp(`\\n {2}checkout: commit ${sha}, 1 uncommitted change\\(s\\)\\n`))
  // .env is hidden from the steps and the root node_modules is a volume: neither is listed.
  assert.match(out, /\n {2}ignored files the steps can see: dist\/\n/)
})

test('a TMPDIR fallback that is not private is said only where it matters: --list, --print-plan and --down use no cache', () => {
  // No XDG_CACHE_HOME and no HOME: the cache falls back to $TMPDIR/ci-local-<uid>,
  // which here any user can write.
  const tmp = mkdtempSync(join(tmpdir(), 'ci-local-tmpdir-'))
  const fallback = join(tmp, `ci-local-${process.getuid()}`)
  mkdirSync(fallback)
  chmodSync(fallback, 0o777)
  const env = { HOME: undefined, XDG_CACHE_HOME: undefined, TMPDIR: tmp, PATH: `${FAKE_DOCKER}:${process.env.PATH}` }

  for (const args of [['--list'], ['--print-plan'], ['--down']]) {
    const { status, err } = ciLocal(args, { env })
    assert.equal(status, 0, args.join(' '))
    assert.equal(err, '', `${args.join(' ')}: nothing on stderr`)
  }

  // --status reads the events file, so it still refuses.
  const refused = ciLocal(['--status'], { env })
  assert.equal(refused.status, 2)
  assert.match(refused.err, /ci-local: .*ci-local-\d+ is not a private directory of this user: no events file, no queue\n/)
})
