// Makes node_modules/@jals1212/ci-local a symlink to this repository, so the
// code under pi/ (its own package, with its own package.json) can import
// '@jals1212/ci-local/status' from the working tree, as it will from npm.
// Run after install and before the tests. Safe to repeat: it leaves alone
// anything already there (a link, or a real install), and never replaces it.

import { lstatSync, mkdirSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const link = join(root, 'node_modules', '@jals1212', 'ci-local')

try {
  lstatSync(link)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  mkdirSync(dirname(link), { recursive: true })
  // 'junction' is what Windows takes without admin rights; the other systems ignore it.
  symlinkSync(root, link, 'junction')
}
