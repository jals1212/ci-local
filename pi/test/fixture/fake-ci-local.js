// A repository's own ci-local for the ci_local_run tests: a bash script in
// node_modules/.bin, as npm and pnpm install it.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Writes `script` (a bash body) as the ci-local of `repo`; returns its path. */
export function fakeCiLocal(repo, script) {
  mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true })
  const bin = join(repo, 'node_modules', '.bin', 'ci-local')
  writeFileSync(bin, `#!/usr/bin/env bash\n${script}\n`)
  chmodSync(bin, 0o755)
  return bin
}
