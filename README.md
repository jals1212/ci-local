# ci-local

Run your Node project's GitHub Actions workflow steps on your own machine, in
Linux, without touching your development stack — and keep the two in step with
a parity test.

```text
$ npx ci-local
ci-local 0.1.0: 6 steps, node 24.21.0, project myapp-ci, jobs: quality tests
...
ci-local summary: node 24.21.0, project myapp-ci, jobs: quality tests
  ok       Build the runner image                                     0s
  ok       Start the Linux runner                                     1s
  ok       npm ci                                                     9s
  ok       npm run lint                                               7s
  ok       Start the database                                         11s
  ok       npm test                                                   1m12s
  total 1m40s
  checkout: commit 3f9c2a1b7d0e, clean
PASSED: every step ran and passed. This is not the GitHub check.
Development stack untouched: 3 container(s), same ids and start times as before.
```

## Why, and how it differs from `act`

[`act`](https://github.com/nektos/act) interprets any workflow and runs it in
containers. ci-local takes another route, for Node projects:

- **You declare the plan; a test keeps it honest.** The steps live in a small
  bash config next to your workflow. `@jals1212/ci-local/parity` compares the
  two and fails your test suite when a command, its order, or a declared
  difference drifts.
- **Your development stack is left alone, and that is checked.** Everything
  ci-local creates carries its own name and label, nothing publishes a port,
  and at the end it compares the id and start time of every container compose
  started from your checkout with what they were before.
- **It runs like the hosted runner where that matters:** the exact Node of
  `.nvmrc`, an ordinary user with your uid and passwordless sudo, ignored dotenv
  files hidden, `localhost` meaning `127.0.0.1` only, `CI=true`.
- **It says what it is not.** It makes no GitHub check green; see [When a local
  run may stand in](#when-a-local-run-may-stand-in).

## Requirements

- Docker (Docker Desktop, OrbStack, Colima or a Linux daemon), reachable at
  `/var/run/docker.sock` or `CI_LOCAL_DOCKER_SOCK`.
- bash 3.2 or later (the one macOS ships is enough).
- A Node project with an exact version in `.nvmrc` (`24.21.0`, not `24`), and
  a GitHub Actions workflow whose `setup-node` reads it.
- npm, or pnpm or yarn pinned in `package.json` (`"packageManager":
  "pnpm@12.9.1"`): the runner has corepack enabled, so the pinned version runs.

## Install

```sh
npm install --save-dev --save-exact @jals1212/ci-local
```

Or pinned to a commit, straight from GitHub:

```sh
npm install --save-dev https://codeload.github.com/jals1212/ci-local/tar.gz/<commit>
```

## Quick start

Create `ci-local.config.sh` at the repository root:

```bash
# shellcheck shell=bash
CI_PROJECT=myapp-ci          # prefix of everything ci-local creates
CI_JOBS=(quality tests)      # what --only selects from

ci_env tests NODE_ENV=test DB_HOST=db

# A workflow step ci-local does not run as written, and why.
ci_not_mirrored "Start the database" "start_database: private network, no published port"

start_database() {
  docker run --detach --name myapp-ci-db --label "$CI_LABEL" \
    --network "$CI_NETWORK" --network-alias db \
    --env POSTGRES_PASSWORD=ci --health-cmd pg_isready --health-interval 2s \
    postgres:17 >/dev/null
  for _ in $(seq 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' myapp-ci-db)" = healthy ] && return 0
    sleep 2
  done
  return 1
}

ci_plan() {
  ci_step host "Build the runner image" ci_build_runner
  ci_step host "Start the Linux runner" ci_start_runner
  ci_step box "npm ci" 'npm ci'
  ci_step box "npm run lint" --job quality 'npm run lint'
  ci_step host "Start the database" --job tests start_database
  ci_step box "npm test" --job tests --env tests 'npm test'
}
```

Then:

```sh
npx ci-local                  # every job
npx ci-local --only tests     # some jobs
npx ci-local --list           # the steps, without running them
npx ci-local --keep           # leave everything up to look at it
npx ci-local --down           # remove what --keep left
```

`npx ci-local --help` has the rest (`--skip TAGS`, `--rebuild`,
`--print-plan`).

## The parity test

With any test runner:

`parityProblems({ cwd, substitutions, jobs })` passes the options on.

```ts
import { parityProblems } from '@jals1212/ci-local/parity'

test('ci-local runs what the workflow runs', async () => {
  assert.deepEqual(await parityProblems(), [])
})
```

`parityProblems` runs three checks, each also exported on its own:

- `mirroringProblems(plan, workflow, { substitutions, jobs })`: every `run:`
  step of every job is a box step with the same commands (comments, blank lines
  and `\` continuations aside), in the workflow's order within each job, or is
  named with `ci_not_mirrored`, or is stood for by a step declared
  `--deviates`; and every `ci_not_mirrored` and `--deviates` names a real step.
  Each workflow job is the ci-local job of the same name (one of `CI_JOBS`), and
  only steps that run for that job count, so `--only tests` runs what the
  `tests` job runs. When the names differ, map them: `jobs: { 'unit-tests':
  'tests' }`. A job with no `run:` step to mirror needs no ci-local job.
  `substitutions` are `[from, to]` pairs for deliberate differences, such as a
  container name.
- `publishedPortProblems(plan, { cwd })`: nothing publishes a port or joins the
  host's network: not the runner, not a `docker run`/`docker create` in a host
  step or in a config function it calls (`-p`, `-p8080:80`, `-dp`, `-P`,
  `--publish`, `--network host`), and not a compose file such a step brings up
  (`docker compose -f FILE up|create|run`, or the default `compose.yaml` and its
  override): `ports:` or `network_mode: host`. `$REPO` and `$CI_PROJECT` in a
  `-f` path are resolved; a compose file that cannot be found or read is a
  problem, not a pass.
- `nodeVersionProblems(workflow)`: `.nvmrc` is exact and every `setup-node`
  reads it, and only it.

`loadPlan()`, `loadWorkflow()` and `stepEnv(step)` let a project check more,
such as the job environment against an `ci_env` set.

## Configuration reference

The config is bash, sourced by ci-local from the repository root (or the file
named by `CI_LOCAL_CONFIG`).

| Variable               | Meaning                                                                      |
| ---------------------- | ---------------------------------------------------------------------------- |
| `CI_PROJECT`           | Required. Lowercase prefix of the runner, network and volumes.               |
| `CI_JOBS`              | Required. The names `--only` and `ci_step --job` use.                        |
| `CI_NETWORK`           | The network the runner joins. Default: `$CI_PROJECT`, created if missing.    |
| `CI_RUNNER_DOCKERFILE` | A Dockerfile that extends the runner: `ARG CI_LOCAL_BASE` / `FROM ${CI_LOCAL_BASE}`. |
| `CI_RUNNER_ARGS`       | Extra `docker run` arguments for the runner (a tmpfs, a volume).             |
| `CI_HIDE_FILES`        | Files hidden from the steps. Default: `.env .env.local`.                     |
| `CI_WORKFLOW`          | The workflow the parity test reads. Default: `.github/workflows/ci.yml`.     |

Set by ci-local for your functions: `CI_LABEL` (put it on what you create;
the cleanup removes everything that carries it) and `CI_NETWORK`.

| Function                          | Meaning                                                    |
| --------------------------------- | ---------------------------------------------------------- |
| `ci_plan`                         | Required. Declares the steps, in order, with `ci_step`.    |
| `ci_step KIND NAME [options] CMD` | A step. See below.                                         |
| `ci_env NAME KEY=VALUE...`        | A named set of variables for `ci_step --env`.              |
| `ci_not_mirrored STEP REASON`     | A workflow step ci-local does not run as written.          |
| `ci_preflight`                    | Optional. Runs before anything starts (read a token).      |
| `ci_teardown`                     | Optional. Extra cleanup (a compose project, an image), after the runner is removed. |
| `ci_on_failure STEP`              | Optional. Diagnostics when STEP fails, before the cleanup (service logs). |
| `ci_build_runner`, `ci_start_runner` | Host steps ci-local provides; put them in your plan.    |

`ci_step` kinds: `box` runs a shell script in the runner with
`bash -eo pipefail`, as GitHub runs `run:`; `host` runs a function of the config
on your machine, with `set -e` in force. Options:

| Option          | Meaning                                                                          |
| --------------- | -------------------------------------------------------------------------------- |
| `--job J1,J2`   | Only when one of these jobs is selected. Without it, always.                     |
| `--env SET`     | Add a set defined with `ci_env`.                                                 |
| `--set K=V`     | Add one variable.                                                                |
| `--pass NAME`   | Pass a variable from your environment by name: its value is never written into the container's configuration. |
| `--timeout S`   | Kill a box step after S seconds.                                                 |
| `--tag TAG`     | A tag `--skip` can name (for example `network`, to work offline).                |
| `--deviates R`  | The step stands for the workflow step of the same name (or first command line) but runs another command on purpose, for reason R. The parity check accepts it in that position; R appears in `--print-plan` and, when the step ran, in a `DEVIATES` line of the summary. |

## What it leaves on your machine

After a run, nothing but caches: the runner images (`ci-local-base:*`, and
`$CI_PROJECT-runner:*` when you extend it), and two volumes,
`$CI_PROJECT-npm-cache` and `$CI_PROJECT-cache` (`~/.cache`: Playwright browsers
and the like). The runner, `node_modules` (a volume: never your host's) and
everything labelled with `CI_LABEL` are removed, unless you passed `--keep`.

The steps run on your checkout, so whatever they write there stays.

## What the steps can see

Your working tree, not the commit GitHub checks out. The summary says which:
the commit, how many uncommitted changes (untracked files included), and the
ignored files the steps can see (a `dist/`, a `coverage/`, a nested
`node_modules`), which a fresh checkout would not have:

```text
  checkout: commit 3f9c2a1b7d0e, 2 uncommitted change(s)
  ignored files the steps can see: dist/ packages/api/node_modules/
```

The root `node_modules` (a volume) and `CI_HIDE_FILES` are hidden, so they are
not listed.

## What it can reach

The runner has the host's Docker socket and passwordless sudo, as GitHub's
runner does: a step can do anything on your machine that Docker can, which is
everything. The end-of-run check that the development stack is untouched
detects a change; it does not prevent one. Run the plans you would run on
your machine anyway.

## What it does not cover

- **It does not make the GitHub check green.** A pull request's check is the
  workflow's run on GitHub; nothing here reports to it.
- Another machine: `ubuntu-latest` is amd64, and on Apple Silicon your steps
  run arm64.
- Another distribution: the runner is `node:<version>-bookworm` (Debian 12),
  `ubuntu-latest` is Ubuntu. System libraries and `apt` packages differ (what
  `playwright install --with-deps` installs, a native module's glibc).
- The workflow's `if:`, `env:`, `defaults`, `working-directory`, `shell` and
  `matrix`: the parity test compares commands, not these. A `${{ }}` in a
  `run:` matches only through `substitutions`.
- `uses:` actions. ci-local runs `run:` steps; an action's effect (a login, a
  cache) is yours to reproduce or to name with `ci_not_mirrored`.

## When a local run may stand in

A suggested rule for merging when GitHub's run cannot be trusted to finish:

A pull request may be merged on a local run **only when the GitHub run failed
before any test ran**, for infrastructure reasons (an image pull refused, a
runner outage). Then:

1. The full local run, `npx ci-local` without `--only` or `--skip`, is green on
   **the pull request's head commit**, checked out with no uncommitted change.
2. The pull request records it in a comment: the commit, the machine, and the
   summary as printed.
3. Then it may be merged.

Any test, lint or type failure on GitHub still blocks the merge, whatever a
local run says. When in doubt, re-run on GitHub.

## License

MIT
