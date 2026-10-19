import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

test('a step declared --deviates stands for its workflow step, whatever its command', async () => {
  const { plan, workflow } = await fixture()
  const e2e = plan.steps.find((step) => step.name === 'npm run e2e')
  assert.notEqual(e2e.command, 'npm run e2e')
  assert.deepEqual(mirroringProblems(plan, workflow, { substitutions: SUBSTITUTIONS }), [])
  e2e.deviates = null
  assert.deepEqual(mirroringProblems(plan, workflow, { substitutions: SUBSTITUTIONS }), [
    'tests: "npm run e2e" is not in the plan (nor named with ci_not_mirrored)',
  ])
})

test('a --deviates step must name a workflow step, in order', async () => {
  const { plan, workflow } = await fixture()
  plan.steps.find((step) => step.name === 'npm run e2e').name = 'npm run gone'
  assert.deepEqual(mirroringProblems(plan, workflow, { substitutions: SUBSTITUTIONS }), [
    'tests: "npm run e2e" is not in the plan (nor named with ci_not_mirrored)',
    '"npm run gone" is declared --deviates, but no workflow step it stands for was found by that name',
  ])
  const steps = workflow.jobs.tests.steps
  plan.steps.find((step) => step.name === 'npm run gone').name = 'npm run e2e'
  steps.splice(steps.length - 2, 0, steps.pop())
  assert.deepEqual(mirroringProblems(plan, workflow, { substitutions: SUBSTITUTIONS }), [
    'tests: "npm test" runs out of the workflow\'s order',
  ])
})

// --------------------------------------------------- published ports, more

const hostPlan = (source, extra = {}) => ({
  project: 'p',
  runnerArgs: [],
  steps: [{ kind: 'host', name: 'Services', command: source.split(' ')[0], source }],
  ...extra,
})

test('a port published without a space, or in a cluster of short flags, is found', () => {
  assert.equal(publishedPortProblems({ runnerArgs: ['-p8080:80'], steps: [] }).length, 1)
  assert.equal(publishedPortProblems({ runnerArgs: ['-p', '8080:80'], steps: [] }).length, 1)
  assert.equal(publishedPortProblems(hostPlan('up () { docker run -dp 80:80 nginx; }')).length, 1)
  assert.equal(publishedPortProblems(hostPlan('up () { docker run -dP nginx; }')).length, 1)
  assert.equal(publishedPortProblems(hostPlan('up () { docker container run --publish=80:80 nginx; }')).length, 1)
})

test('other flags that contain a p are not a published port', () => {
  for (const source of [
    'up () { docker run -d -ePATH=/x -v /tmp:/tmp nginx; }',
    'up () { docker run -d -e P=1 --pull always nginx; }',
    'up () { docker run -d nginx && mkdir -p tmp; }',
  ]) {
    assert.deepEqual(publishedPortProblems(hostPlan(source)), [], source)
  }
})

test('the host network is found, as it shares every port with the machine', () => {
  assert.equal(publishedPortProblems(hostPlan('up () { docker run -d --network host nginx; }')).length, 1)
  assert.equal(publishedPortProblems(hostPlan('up () { docker run -d --net=host nginx; }')).length, 1)
  assert.equal(publishedPortProblems({ runnerArgs: ['--network=host'], steps: [] }).length, 1)
})

test('a port published in a function the host step calls is found', () => {
  const plan = hostPlan('up () { echo starting; start_web; }', {
    functions: {
      up: 'up () { echo starting; start_web; }',
      start_web: 'start_web () { docker run -d -p 80:80 nginx; }',
    },
  })
  assert.deepEqual(publishedPortProblems(plan), [
    'host step "Services" publishes a port: start_web () { docker run -d -p 80:80 nginx; }',
  ])
})

const composeProject = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-local-compose-'))
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  return dir
}

test('ports in a compose file a host step brings up are found', () => {
  const cwd = composeProject({
    'compose.ci.yml': 'services:\n  db:\n    image: postgres:17\n    ports: ["5432:5432"]\n  cache:\n    image: redis\n',
  })
  for (const source of [
    'up () { docker compose -f compose.ci.yml -p "$CI_PROJECT" up -d --wait; }',
    'up () { docker compose --file="$REPO/compose.ci.yml" up -d; }',
  ]) {
    assert.deepEqual(publishedPortProblems(hostPlan(source), { cwd }), [
      'host step "Services": compose.ci.yml publishes ports of service "db"',
    ], source)
  }
})

test('the default compose file and its override are read when no -f is given', () => {
  const cwd = composeProject({
    'compose.yaml': 'services:\n  db:\n    image: postgres:17\n',
    'compose.override.yaml': 'services:\n  db:\n    network_mode: host\n',
  })
  assert.deepEqual(publishedPortProblems(hostPlan('up () { docker compose up -d; }'), { cwd }), [
    'host step "Services": compose.override.yaml puts service "db" on the host network',
  ])
})

test('a compose file without ports, or a compose command that starts nothing, is no problem', () => {
  const cwd = composeProject({
    'compose.yaml': 'services:\n  db:\n    image: postgres:17\n    ports: ["5432:5432"]\n',
    'compose.ci.yml': 'services:\n  db:\n    image: postgres:17\n    expose: ["5432"]\n',
  })
  assert.deepEqual(publishedPortProblems(hostPlan('up () { docker compose -f compose.ci.yml up -d; }'), { cwd }), [])
  assert.deepEqual(publishedPortProblems(hostPlan('logs () { docker compose logs db; }'), { cwd }), [])
})

// The dossier stack (#41): files from COMPOSE_FILE, an override that resets
// every port, host-network services behind a profile nobody enables.
const DOSSIER_BASE = `services:
  postgres:
    image: postgres:17
    ports: ["5432:5432"]
  minio:
    image: minio/minio
    ports: ["9000:9000", "9001:9001"]
  clamav:
    image: clamav/clamav
    ports: ["3310:3310"]
  redis:
    image: redis
    ports: ["6379:6379"]
  api:
    image: api
    profiles: [app]
    network_mode: host
    depends_on: [postgres]
  worker:
    image: worker
    profiles: [app]
    network_mode: host
`
const DOSSIER_OVERRIDE = `services:
  postgres:
    ports: !reset []
  minio:
    ports: !reset []
  clamav:
    ports: !reset []
  redis:
    ports: !reset []
`
const dossier = (extra = {}) =>
  composeProject({ 'docker-compose.yml': DOSSIER_BASE, 'docker/ci-local/compose.override.yml': DOSSIER_OVERRIDE, ...extra })
const COMPOSE_FILE = 'docker-compose.yml:docker/ci-local/compose.override.yml'

test('with no -f the files come from COMPOSE_FILE, merged in order, and !reset clears the ports', () => {
  const cwd = dossier()
  const plan = hostPlan('up () { docker compose up -d --wait postgres minio clamav; }', { composeEnv: { COMPOSE_FILE } })
  assert.deepEqual(publishedPortProblems(plan, { cwd }), [])
  plan.composeEnv.COMPOSE_FILE = 'docker-compose.yml'
  assert.deepEqual(publishedPortProblems(plan, { cwd }), [
    'host step "Services": docker-compose.yml publishes ports of service "postgres"',
    'host step "Services": docker-compose.yml publishes ports of service "minio"',
    'host step "Services": docker-compose.yml publishes ports of service "clamav"',
  ])
})

test('COMPOSE_PATH_SEPARATOR splits COMPOSE_FILE, and $REPO in it is resolved', () => {
  const cwd = dossier()
  const plan = hostPlan('up () { docker compose up -d postgres; }', {
    composeEnv: { COMPOSE_FILE: '$REPO/docker-compose.yml;$REPO/docker/ci-local/compose.override.yml', COMPOSE_PATH_SEPARATOR: ';' },
  })
  assert.deepEqual(publishedPortProblems(plan, { cwd }), [])
})

test('-f files are merged in order: a later !reset or !override replaces, a plain list adds', () => {
  const cwd = dossier({
    'more.yml': 'services:\n  redis:\n    ports: ["6380:6379"]\n',
    'replace.yml': 'services:\n  redis:\n    ports: !override ["6381:6379"]\n  api: !reset {}\n',
  })
  const up = (files) => publishedPortProblems(hostPlan(`up () { docker compose ${files} up -d; }`), { cwd })
  assert.deepEqual(up('-f docker-compose.yml -f docker/ci-local/compose.override.yml'), [])
  assert.deepEqual(up('-f docker-compose.yml -f docker/ci-local/compose.override.yml -f more.yml'), [
    'host step "Services": more.yml publishes ports of service "redis"',
  ])
  assert.deepEqual(up('-f docker-compose.yml -f replace.yml --profile app'), [
    'host step "Services": docker-compose.yml publishes ports of service "postgres"',
    'host step "Services": docker-compose.yml publishes ports of service "minio"',
    'host step "Services": docker-compose.yml publishes ports of service "clamav"',
    'host step "Services": replace.yml publishes ports of service "redis"',
    'host step "Services": docker-compose.yml puts service "worker" on the host network',
  ])
})

test('a service behind a profile counts only when the profile is enabled', () => {
  const cwd = dossier()
  const problems = (source, composeEnv = { COMPOSE_FILE }) =>
    publishedPortProblems(hostPlan(source, { composeEnv }), { cwd })
  const hostNetwork = [
    'host step "Services": docker-compose.yml puts service "api" on the host network',
    'host step "Services": docker-compose.yml puts service "worker" on the host network',
  ]
  assert.deepEqual(problems('up () { docker compose up -d; }'), [])
  assert.deepEqual(problems('up () { docker compose --profile app up -d; }'), hostNetwork)
  assert.deepEqual(problems('up () { docker compose --profile="*" up -d; }'), hostNetwork)
  assert.deepEqual(problems('up () { docker compose up -d; }', { COMPOSE_FILE, COMPOSE_PROFILES: 'other,app' }), hostNetwork)
})

test('COMPOSE_FILE and COMPOSE_PROFILES are read from .env too, below the environment', () => {
  const cwd = dossier({ '.env': `# compose\nCOMPOSE_FILE=${COMPOSE_FILE}\nexport COMPOSE_PROFILES="app"\n` })
  assert.deepEqual(publishedPortProblems(hostPlan('up () { docker compose up -d; }'), { cwd }), [
    'host step "Services": docker-compose.yml puts service "api" on the host network',
    'host step "Services": docker-compose.yml puts service "worker" on the host network',
  ])
  const plan = hostPlan('up () { docker compose up -d; }', { composeEnv: { COMPOSE_PROFILES: '' } })
  assert.deepEqual(publishedPortProblems(plan, { cwd }), [])
})

test('a service named after up starts, whatever its profile, with what it depends on', () => {
  const cwd = dossier({ 'docker/ci-local/compose.override.yml': 'services: {}\n' })
  const plan = hostPlan('up () { docker compose up -d --scale redis=1 -t 5 api; }', { composeEnv: { COMPOSE_FILE } })
  assert.deepEqual(publishedPortProblems(plan, { cwd }), [
    'host step "Services": docker-compose.yml publishes ports of service "postgres"',
    'host step "Services": docker-compose.yml puts service "api" on the host network',
  ])
})

test('a service name that cannot be read counts every service', () => {
  const cwd = dossier()
  const plan = hostPlan('up () { docker compose up -d $SERVICES; }', { composeEnv: { COMPOSE_FILE } })
  assert.equal(publishedPortProblems(plan, { cwd }).length, 2)
})

test('"$@" in the host step\'s own function is the arguments the step gives it', () => {
  const cwd = dossier()
  const source = 'start_stack () { docker compose up -d --wait "$@"; }'
  const plan = hostPlan(source, { composeEnv: { COMPOSE_FILE } })
  plan.steps[0].command = 'start_stack postgres minio clamav'
  plan.steps[0].args = ['postgres', 'minio', 'clamav']
  assert.deepEqual(publishedPortProblems(plan, { cwd }), [])
  plan.steps[0].args = ['api']
  assert.deepEqual(publishedPortProblems(plan, { cwd }), [
    'host step "Services": docker-compose.yml puts service "api" on the host network',
  ])
})

test('compose run publishes the ports of what it depends on, not of its own service', () => {
  const cwd = dossier({ 'docker/ci-local/compose.override.yml': 'services:\n  api:\n    network_mode: !reset null\n    ports: ["80:80"]\n' })
  const plan = hostPlan('up () { docker compose run --rm -e X=1 api npm test; }', { composeEnv: { COMPOSE_FILE } })
  assert.deepEqual(publishedPortProblems(plan, { cwd }), [
    'host step "Services": docker-compose.yml publishes ports of service "postgres"',
  ])
})

test('a compose file that cannot be read is a problem, not a pass', () => {
  const cwd = composeProject({})
  assert.deepEqual(publishedPortProblems(hostPlan('up () { docker compose -f "$SOMEWHERE/x.yml" up -d; }'), { cwd }), [
    'host step "Services": cannot check compose file "$SOMEWHERE/x.yml" for published ports',
  ])
})

// ------------------------------------------------------------ jobs

test('a workflow command matched only by a step of another job is named', async () => {
  const { plan, workflow } = await fixture()
  workflow.jobs.tests.steps.push({ run: 'npm run lint' })
  assert.deepEqual(mirroringProblems(plan, workflow, { substitutions: SUBSTITUTIONS }), [
    'tests: "npm run lint" is in the plan only for other jobs (quality)',
  ])
})

test('a workflow job that is no ci-local job is named, unless mapped with the jobs option', async () => {
  const { plan, workflow } = await fixture()
  workflow.jobs.lint = workflow.jobs.quality
  delete workflow.jobs.quality
  assert.deepEqual(mirroringProblems(plan, workflow, { substitutions: SUBSTITUTIONS }), [
    'workflow job "lint" is no ci-local job: add it to CI_JOBS, or map it with the jobs option',
  ])
  assert.deepEqual(mirroringProblems(plan, workflow, { substitutions: SUBSTITUTIONS, jobs: { lint: 'quality' } }), [])
})

test('a workflow job with nothing to mirror needs no ci-local job', async () => {
  const { plan, workflow } = await fixture()
  workflow.jobs.label = { steps: [{ uses: 'actions/labeler@v5' }] }
  assert.deepEqual(mirroringProblems(plan, workflow, { substitutions: SUBSTITUTIONS }), [])
})
