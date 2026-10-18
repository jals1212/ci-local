// The package's public entry points: what `exports` lets a reader import, and
// that status.d.ts names only what status.js has.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

import * as local from '../status.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('@jals1212/ci-local/status is status.js, imported by the package name', async () => {
  const named = await import('@jals1212/ci-local/status')
  assert.deepEqual(Object.keys(named).sort(), Object.keys(local).sort())
  for (const [name, value] of Object.entries(local)) assert.equal(named[name], value, name)
})

test('exports keeps ./parity and ./package.json, and ./status has its types', () => {
  assert.deepEqual(pkg.exports['./status'], { types: './status.d.ts', default: './status.js' })
  assert.deepEqual(pkg.exports['./parity'], { types: './parity.d.ts', default: './parity.js' })
  assert.equal(pkg.exports['./package.json'], './package.json')
  assert.ok(pkg.files.includes('status.d.ts'))
})

test('every value status.d.ts declares exists in status.js, and status.js exports nothing it leaves out', () => {
  const declared = readFileSync(new URL('../status.d.ts', import.meta.url), 'utf8')
  const values = [...declared.matchAll(/^export (?:declare )?(?:const|function) (\w+)/gm)].map((match) => match[1])
  assert.ok(values.length > 0)
  for (const name of values) assert.ok(name in local, `${name} is declared but status.js does not export it`)
  assert.deepEqual(values.sort(), Object.keys(local).sort())
})

test('the CLI still has a Pi entry, the bridge, and ships it without pi/package.json', () => {
  assert.deepEqual(pkg.pi, { extensions: ['./pi/bridge.ts'], skills: ['./pi/skills'] })
  for (const file of ['pi/bridge.ts', 'pi/extensions', 'pi/skills']) {
    assert.ok(pkg.files.includes(file), `files has ${file}`)
    assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${file} exists`)
  }
  // Inside the installed CLI the nearest package.json must be the CLI's, or
  // '@jals1212/ci-local/status' would not resolve from pi/extensions/core.js.
  assert.ok(!pkg.files.some((file) => file === 'pi' || file.startsWith('pi/package')))
  assert.equal(pkg.peerDependencies, undefined, 'the Pi peers belong to @jals1212/ci-local-pi')
})
