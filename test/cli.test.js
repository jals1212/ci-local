// The command line of bin/ci-local: what it answers before Docker is touched.
// Only options that start nothing run here (--list, --print-plan, --help,
// --version and the refusals); the steps themselves are proven by running
// ci-local in a project.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../bin/ci-local', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./fixture/', import.meta.url))

function ciLocal(args, { cwd = FIXTURE, env = {} } = {}) {
  const result = spawnSync('bash', [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
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
    for (const option of ['--only', '--skip', '--keep', '--down', '--rebuild', '--list', '--print-plan', '--version']) {
      assert.match(out, new RegExp(`\\n  ${option}\\b`), option)
    }
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
  assert.equal(plan.steps.length, 8)
  assert.deepEqual(plan.notMirrored, [
    { name: 'Start the database', reason: 'start_database: on the private network, no published port' },
  ])
  const test = plan.steps.find((step) => step.name === 'npm test')
  assert.deepEqual(test.env, ['NODE_ENV=test', 'DB_HOST=db', 'EXTRA=1'])
  assert.deepEqual(test.jobs, ['tests'])
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
  const { status, out, err } = ciLocal([], { cwd: dir })
  assert.equal(status, 1)
  assert.match(out, /before/)
  assert.doesNotMatch(out, /after-the-failure/)
  assert.doesNotMatch(out, /second-step/)
  assert.match(out, /FAILED at step: Fails midway/)
  assert.match(out, /diagnostics for: Fails midway/)
  assert.match(err, /Fails midway: FAILED with exit code 1/)
})
