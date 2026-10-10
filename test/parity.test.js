import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  loadPlan,
  loadWorkflow,
  mirroringProblems,
  nodeVersionProblems,
  parityProblems,
  publishedPortProblems,
  stepEnv,
} from '../parity.js'

const cwd = fileURLToPath(new URL('./fixture/', import.meta.url))
const SUBSTITUTIONS = [['docker exec db ', 'docker exec fixture-ci-db ']]

const fixture = async () => {
  const plan = await loadPlan({ cwd })
  return { plan, workflow: await loadWorkflow({ cwd, plan }) }
}

test('the fixture agrees with its workflow', async () => {
  assert.deepEqual(await parityProblems({ cwd, substitutions: SUBSTITUTIONS }), [])
})

test('a workflow command missing from the plan is named', async () => {
  const { plan, workflow } = await fixture()
  workflow.jobs.quality.steps.push({ name: 'Format', run: 'npm run format:check' })
  assert.deepEqual(mirroringProblems(plan, workflow, { substitutions: SUBSTITUTIONS }), [
    'quality: "Format" is not in the plan (nor named with ci_not_mirrored)',
  ])
})

test('a difference the project did not declare is a problem', async () => {
  const { plan, workflow } = await fixture()
  assert.deepEqual(mirroringProblems(plan, workflow), [
    'tests: "Create the database" is not in the plan (nor named with ci_not_mirrored)',
  ])
})

test('a changed command is a problem, a changed comment or line break is not', async () => {
  const { plan, workflow } = await fixture()
  const lint = workflow.jobs.quality.steps.find((step) => step.run === 'npm run lint')
  lint.run = '# Lint everything\nnpm   run \\\n  lint\n'
  assert.deepEqual(mirroringProblems(plan, workflow, { substitutions: SUBSTITUTIONS }), [])
  lint.run = 'npm run lint -- --max-warnings 0'
  assert.equal(mirroringProblems(plan, workflow, { substitutions: SUBSTITUTIONS }).length, 1)
})

test('steps run out of the workflow order are named', async () => {
  const { plan, workflow } = await fixture()
  const steps = workflow.jobs.quality.steps
  const audit = steps.findIndex((step) => step.name === 'Audit')
  ;[steps[audit], steps[audit + 1]] = [steps[audit + 1], steps[audit]]
  assert.deepEqual(mirroringProblems(plan, workflow, { substitutions: SUBSTITUTIONS }), [
    'quality: "Audit" runs out of the workflow\'s order',
  ])
})

test('ci_not_mirrored must name a workflow step', async () => {
  const { plan, workflow } = await fixture()
  plan.notMirrored.push({ name: 'Gone', reason: 'stale' })
  assert.deepEqual(mirroringProblems(plan, workflow, { substitutions: SUBSTITUTIONS }), [
    'ci_not_mirrored names "Gone", which is no step of the workflow',
  ])
})

test('a published port is found in the runner args and in host steps', async () => {
  const { plan } = await fixture()
  assert.deepEqual(publishedPortProblems(plan), [])
  const host = plan.steps.find((step) => step.kind === 'host' && step.name === 'Start the database')
  host.source = host.source.replace('--network-alias db', '--network-alias db -p 5432:5432 \\\n  ')
  plan.runnerArgs.push('--publish=3333:3333')
  assert.equal(publishedPortProblems(plan).length, 2)
})

test('-p in another command is not a published port', async () => {
  const { plan } = await fixture()
  plan.steps.push({ kind: 'host', name: 'Make', command: 'make_dir', source: 'make_dir () { mkdir -p tmp; }' })
  assert.deepEqual(publishedPortProblems(plan), [])
})

test('setup-node must read .nvmrc and nothing else', async () => {
  const { workflow } = await fixture()
  assert.deepEqual(await nodeVersionProblems(workflow, { cwd }), [])
  workflow.jobs.tests.steps[1].with = { 'node-version': '24' }
  assert.deepEqual(await nodeVersionProblems(workflow, { cwd }), [
    'tests: setup-node does not read node-version-file: .nvmrc',
    'tests: setup-node also sets node-version',
  ])
})

test('stepEnv turns the env entries into an object', async () => {
  const { plan } = await fixture()
  assert.deepEqual(stepEnv(plan.steps.find((step) => step.name === 'npm test')), {
    NODE_ENV: 'test',
    DB_HOST: 'db',
    EXTRA: '1',
  })
})
