// What @jals1212/ci-local-pi declares: its Pi entries exist and ship, and it
// reads the CLI through the CLI's public entry point.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('the Pi entries exist and are in files', () => {
  assert.equal(pkg.name, '@jals1212/ci-local-pi')
  assert.deepEqual(pkg.pi, { extensions: ['./extensions/ci-local.ts'], skills: ['./skills'] })
  for (const entry of [...pkg.pi.extensions, ...pkg.pi.skills]) {
    assert.ok(existsSync(new URL(entry, new URL('../', import.meta.url))), `${entry} exists`)
    assert.ok(pkg.files.includes(entry.split('/')[1]), `${entry} is shipped`)
  }
  for (const file of ['README.md', 'CHANGELOG.md']) assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), file)
})

test('the CLI is a dependency, and the Pi packages are optional peers', () => {
  assert.ok(pkg.dependencies['@jals1212/ci-local'])
  for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']) {
    assert.equal(pkg.peerDependenciesMeta[name].optional, true, name)
  }
})

test('the code imports the CLI by its package name, never by a path into it', () => {
  const core = readFileSync(new URL('../extensions/core.js', import.meta.url), 'utf8')
  assert.match(core, /from '@jals1212\/ci-local\/status'/)
  assert.doesNotMatch(core, /from '\.\.\/\.\.?\//)
})
