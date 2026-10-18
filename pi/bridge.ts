// What the CLI's `pi` entry loads, for one more minor (0.7.x): the same
// extension as @jals1212/ci-local-pi, which also says once per session that it
// moved, and steps aside when the package is loaded too. 0.8.0 drops this file.

import { createCiLocalExtension } from './extensions/ci-local.ts'

export default createCiLocalExtension({ role: 'bridge' })
