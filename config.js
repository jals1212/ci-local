#!/usr/bin/env node
// The user's settings file of ci-local (schema ci-local.config/v1), read for
// bin/ci-local: `node config.js FILE` prints one NAME=value line per setting
// it holds, as the environment variable that setting stands for. A file that
// is not valid (not JSON, another schema, an unknown key, a wrong type or
// value) prints nothing and says why on stderr: the run goes on without it.
//
//   {
//     "schema": "ci-local.config/v1",
//     "maxRuns": 2,
//     "queue": { "enabled": true, "dir": "/abs/path", "poll": 2, "timeout": 0, "notice": 300 }
//   }

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const SCHEMA = 'ci-local.config/v1'

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const wholeIn = (value, min, max) => Number.isInteger(value) && value >= min && value <= max

const isAbsolutePath = (v) => typeof v === 'string' && v.startsWith('/') && !/[\u0000-\u001f]/.test(v)
const isSeconds = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 3600

/**
 * A setting of the file: the environment variable it stands for, whether a
 * value is valid, what a valid one is (for the error), and the variable's text.
 */
const setting = (variable, valid, expected, text = String) => ({ variable, valid, expected, text })

const SETTINGS = {
  maxRuns: setting('CI_LOCAL_MAX_RUNS', (v) => wholeIn(v, 1, 99), 'a whole number from 1 to 99'),
}
const QUEUE = {
  enabled: setting('CI_LOCAL_QUEUE', (v) => typeof v === 'boolean', 'true or false', (v) => (v ? 'on' : 'off')),
  dir: setting('CI_LOCAL_QUEUE_DIR', isAbsolutePath, 'an absolute path'),
  poll: setting('CI_LOCAL_QUEUE_POLL', isSeconds, 'seconds above 0, at most 3600'),
  timeout: setting('CI_LOCAL_QUEUE_TIMEOUT', (v) => wholeIn(v, 0, 999_999_999), 'whole seconds, 0 or more'),
  notice: setting('CI_LOCAL_QUEUE_NOTICE', (v) => wholeIn(v, 0, 999_999_999), 'whole seconds, 0 or more'),
}

/**
 * The variables a parsed settings file stands for, as [name, value] pairs, or
 * the first reason it is not valid: `{ vars }` or `{ error }`.
 */
export function settingsVars(data) {
  if (!isObject(data)) return { error: 'not a JSON object' }
  if (data.schema !== SCHEMA) return { error: `schema must be "${SCHEMA}", got ${JSON.stringify(data.schema)}` }
  const vars = []
  const take = (table, object, prefix) => {
    for (const [key, value] of Object.entries(object)) {
      // Own keys only: `constructor` or `toString` are not settings.
      const known = Object.hasOwn(table, key) ? table[key] : undefined
      if (!known) return `unknown key "${prefix}${key}"`
      if (!known.valid(value)) return `"${prefix}${key}" must be ${known.expected}, got ${JSON.stringify(value)}`
      vars.push([known.variable, known.text(value)])
    }
    return null
  }
  // `schema` is checked above; `queue` is a table of its own.
  const top = Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'schema' && key !== 'queue'))
  const { queue } = data
  let error = take(SETTINGS, top, '')
  if (!error && queue !== undefined) error = isObject(queue) ? take(QUEUE, queue, 'queue.') : '"queue" must be an object'
  return error ? { error } : { vars }
}

function main(file) {
  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    const why = error.code ? `cannot be read (${error.code})` : `is not JSON (${error.message})`
    process.stderr.write(`ci-local: ${file} ${why}: its settings are ignored\n`)
    return
  }
  const { vars, error } = settingsVars(data)
  if (error) {
    process.stderr.write(`ci-local: ${file}: ${error}: its settings are ignored\n`)
    return
  }
  process.stdout.write(vars.map(([name, value]) => `${name}=${value}\n`).join(''))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv[2])
