// The package's public entry points: what `exports` lets a reader import, and
// that status.d.ts names only what status.js has.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import * as local from '../status.js'

const root = fileURLToPath(new URL('..', import.meta.url))
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

test('the CLI is not a Pi package: no pi manifest, nothing of pi/ shipped, no Pi peers', () => {
  assert.equal(pkg.pi, undefined)
  assert.ok(!pkg.keywords.includes('pi-package'), 'the pi-package keyword belongs to @jals1212/ci-local-pi')
  assert.deepEqual(
    pkg.files.filter((file) => file === 'pi' || file.startsWith('pi/')),
    []
  )
  assert.equal(pkg.peerDependencies, undefined, 'the Pi peers belong to @jals1212/ci-local-pi')
})

test('npm pack ships nothing from pi/', () => {
  const out = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' })
  assert.equal(out.status, 0, out.stderr)
  // npm 11 prints an object keyed by package name, older npm an array.
  const packed = JSON.parse(out.stdout)
  const [{ files }] = Array.isArray(packed) ? packed : Object.values(packed)
  const shipped = files.map((file) => file.path)
  assert.deepEqual(shipped.filter((path) => path.startsWith('pi/')), [])
  assert.ok(shipped.includes('bin/ci-local') && shipped.includes('status.js'))
})
