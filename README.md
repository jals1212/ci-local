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

**Install it in each repository, not globally.** Each repository pins the
version its config and its parity test were written for, `npx ci-local` (or
`pnpm exec ci-local`) runs that one, and the parity test imports
`@jals1212/ci-local/parity` from the repository's own `node_modules`. A global
install would run one version for every repository.

The [Pi package](#in-pi-status-line-end-card-and-agent-skill) is the exception: it
only reads the events each run writes, so it is installed once, for Pi, with
`pi install npm:@jals1212/ci-local`.

**Keep the repositories on one machine at 0.4.0 or later together.** The
queue and the default events file came in 0.4.0: a run of an older version
takes no turn in the queue (it may run alongside a newer one) and writes no
events unless given `--events` (`--status` and Pi do not see it). Event
fields are only ever added, so a newer `--status` or Pi package reads the
events of an older 0.4.x run.

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
npx ci-local --quiet          # step output to log files, milestones only
npx ci-local --live           # step output live, even without a terminal
npx ci-local --events run.ndjson  # one JSON line per milestone, to follow
npx ci-local --status         # the last run: queued, running, passed, failed or stopped
```

`npx ci-local --help` has the rest (`--skip TAGS`, `--rebuild`,
`--print-plan`, `--no-wait`).

## Following a run

In a terminal, every step's output goes to the screen **live**, line by line,
as the command writes it: a test reporter's progress shows as it happens. Each
step is framed by a milestone when it starts and when it ends:

```text
==> [9/12] pnpm run test:integration
...the reporter's output, live...
<== pnpm run test:integration: ok (7m14s)
```

Without a terminal (stdout is not one: an agent, a background job, a pipe),
nobody watches, so a run is **quiet** by default: each step's output goes to
its own log file, and stdout gets only the milestones, the summary and, when
a step fails, the last 40 lines of its log. The log directory is printed at
the start and left in place after the run:

```text
ci-local 0.6.0: 12 steps, node 24.21.0, project myapp-ci, jobs: quality tests
Step output: /tmp/myapp-ci-logs.Xa81Qe
Events: /home/me/.cache/ci-local/myapp-ci.ndjson (ci-local --status)

==> [1/12] Build the runner image
<== Build the runner image: ok (0s)
...
```

**`--quiet`** (or `CI_LOCAL_QUIET=1`) makes a run quiet in a terminal too;
**`--live`** (or `CI_LOCAL_QUIET=0`) shows the output live without one, as
`ci-local --live | tee run.log`. On the command line, the last of the two
wins over the environment. Neither changes the summary or the lines after it.

**`--events FILE`** (or `CI_LOCAL_EVENTS=FILE`): one JSON object per line for
every milestone, for another terminal or a status display. The file is emptied
when the run starts; a relative path is taken from where you run ci-local. A
file that cannot be written stops the run before any step, with status 2.

Without `--events`, a run writes its events to
`~/.cache/ci-local/<project>.ndjson` (`$XDG_CACHE_HOME/ci-local/` when that is
set; with neither `XDG_CACHE_HOME` nor `HOME`, a private directory under
`TMPDIR`), names it at the start, and goes on with a warning if it cannot write
there. `CI_LOCAL_EVENTS=off` writes no events file.

One events file holds one run. A run takes the file only when no live run
of the project still writes it (its first event names a process that is
alive, and no `end` event closed it): it then empties the file and writes its
first event in one step, under a `<file>.claim` directory, so two runs that
start together cannot both take it. A second run of a project waits in the
queue without writing events and takes the file at its turn, when the first
run is over; with `CI_LOCAL_QUEUE=off` it writes no events at all and says
so. A `.claim` directory older than 10 seconds is a crashed run's and is
removed; one that cannot be removed makes the run write no events, and say
so. Where no claim can be made at all (a writable `--events` file in a
directory you cannot write), the file is taken without one, as before 0.4.0.

Put the file outside the checkout (inside, it is an uncommitted change in the
summary) and in a directory only you can write: emptying a fixed name in a
shared `/tmp` follows whatever another user left there under that name.

With `--list`, `--print-plan` or `--down`, which run no step, `--quiet`,
`--live` and `--events` given on the command line are ignored, with a warning
on stderr.
Set in the environment they are a standing preference, and ignored quietly.

| `event` | When | Fields besides `ts` (ISO 8601, UTC, milliseconds) |
| --- | --- | --- |
| `queued` | the run is waiting for its turn (see [the queue](#one-run-at-a-time-the-queue)); again when whom it waits for changes, and when its turn comes | `project`, `version`, `pid`, `pidStart`, `commit`, `args`, `logDir`, `session`, `ancestors` (as in `run`), `ahead` (live runs before it), `blockedBy` (`{"project", "pid"}` of the run it waits for; `null` when nobody) |
| `run` | the run has its turn and the steps are about to run | `project`, `jobs`, `total`, `version`, `pid` (of ci-local), `pidStart` (its start time, as `ps -o lstart=` prints it in the C locale and UTC, for example `Sun Oct 18 14:58:57 2026`; `null` when `ps` cannot say), `commit` (12 characters; `null` outside git), `args` (the command line), `logDir` (when quiet; else `null`), `session` (the Pi session that started it, from `PI_SESSION_ID`; else `null`), `ancestors` (the pids above ci-local when it started, its parent first, up to but not with pid 1, at most 32; `[]` when `ps` cannot say. The Pi extension reads it to tell a run its session started from one that lost its parents since, by `nohup` or `setsid`) |
| `start` | a step starts | `step`, `index` (from 1), `total`; `log` when quiet; `deviates` (the reason) when the step is marked `--deviates` |
| `ok` | a step passed | `step`, `index`, `total`, `durationMs`; `log` when quiet; `deviates` as in `start` |
| `fail` | a step failed or was interrupted | `step`, `index`, `total`, `exitCode`, `durationMs`; `log` when quiet; `deviates` as in `start` |
| `end` | after the cleanup | `result` (`passed`, `failed`, `interrupted`), `devStack` (`untouched`, `changed`, `none`), `deviations` (how many `--deviates` steps started), `durationMs` |

```sh
# terminal 1
mkdir -p ~/.cache/ci-local
npx ci-local --quiet --events ~/.cache/ci-local/myapp-ci.ndjson

# terminal 2
tail -f ~/.cache/ci-local/myapp-ci.ndjson
tail -f ~/.cache/ci-local/myapp-ci.ndjson |
  jq -r --unbuffered '"\(.ts[11:19]) \(.event) \(.step // .result // .project) \(if .durationMs then "(\(.durationMs / 1000 | floor)s)" else "" end)"'
```

```text
{"ts":"2026-05-02T10:14:03.512Z","event":"run","project":"myapp-ci","jobs":["quality","tests"],"total":6}
{"ts":"2026-05-02T10:14:03.530Z","event":"start","step":"Build the runner image","index":1,"total":6}
{"ts":"2026-05-02T10:14:03.871Z","event":"ok","step":"Build the runner image","index":1,"total":6,"durationMs":341}
...
{"ts":"2026-05-02T10:15:44.020Z","event":"end","result":"passed","durationMs":100508}
```

To wait for a run without reading it, wait for the `end` event, or for the
process to exit and read its summary: its status and the `PASSED:` /
`FAILED at step:` line are the same in every mode.

### The state of the last run: `--status`

`ci-local --status` reads the events file (the default one, or the one named
with `--events`, which then needs no config) and prints three lines of
Markdown, ready to paste in a chat or a pull request, while the run goes on
and after it ends. It needs no Docker and changes nothing.

```text
> 🚦 ⧗ **ci-local** · running · [9/12] pnpm run test:integration
> `ci-local --quiet` · project `myapp-ci` · `3f2a91c0b7de` · 6m41s so far
> Follow it: `tail -f /home/me/.cache/ci-local/myapp-ci.ndjson` · step output: `/tmp/myapp-ci-logs.Xa81Qe`

> 🚦 ◌ **ci-local** · queued · behind other-ci (1 ahead)
> `ci-local --quiet` · project `myapp-ci` · `3f2a91c0b7de` · waiting 4m12s
> Follow it: `tail -f /home/me/.cache/ci-local/myapp-ci.ndjson`

> 🚦 ⧗ **ci-local** · starting
> `ci-local --quiet` · project `myapp-ci` · `3f2a91c0b7de` · 2s so far
> Follow it: `tail -f /home/me/.cache/ci-local/myapp-ci.ndjson`

> 🚦 ✓ **ci-local** · passed
> `ci-local` · project `myapp-ci` · `3f2a91c0b7de`
> 12 steps · 9m03s · every step passed · 1 deviation (pnpm run test:integration) · Development stack untouched.

> 🚦 ✗ **ci-local** · failed
> `ci-local --quiet` · project `myapp-ci` · `3f2a91c0b7de`
> Failed at: pnpm run lint (step 5/12, exit 1) · 2m10s · log: `/tmp/myapp-ci-logs.Xa81Qe/05-pnpm-run-lint.log`.

> 🚦 ⊘ **ci-local** · stopped
> `ci-local` · project `myapp-ci` · `3f2a91c0b7de`
> No end: process 48213 is gone (killed, or Docker froze) · during: pnpm test (step 8/12).
```

Each first line starts with 🚦, ci-local's own emoji (as Engram has 🧠 and
RDD 🌹 in Gentle Shell), then the state's one-column mark: `◌` queued, `⧗`
starting or running, `✓` passed, `✗` failed, `⊘` stopped. The Pi status line
and cards use the same two.

A run with no `end` event is `queued` while it waits for its turn, `starting`
once it has it and has not yet begun its steps, `running` after that, as long
as its process lives, and `stopped` once it is gone (also when it was
interrupted while queued). Exit status: 0 passed,
1 failed, 2 no run recorded, 3 queued, starting or running, 4 stopped
(interrupted, or gone without an end), so a script can wait with
`while ci-local --status >/dev/null; [ $? -eq 3 ]; do sleep 10; done`.

A step marked `--deviates` runs another command than its workflow step, on
purpose, so a passed run is weaker than GitHub's. The `passed` block says
which: `1 deviation (pnpm run test:integration)`, or `3 deviations (a, b, …)`
(the first two names). It reads the `deviates` field of the step events and
the `deviations` count of `end`; events from before 0.6.0 have neither and
show as before. The Pi card shows the same block.

The time in the block (and in the Pi card) runs from the `run` event to the
`end` event, so it includes the cleanup; the summary's `total` counts the
steps alone, and neither counts the wait in the queue. A run of 13m47s of
steps shows as about 13m50s here.

"Its process lives" means a process with the run's pid exists and started when
the run did: a run records its start time (`pidStart`) next to its pid, so a
killed run whose pid the system gave to another process shows as `stopped`,
not as still going. The queue's tickets and lock, and the claim of the events
file by the next run, tell the same way. Start times are read with
`ps -o lstart=`, which macOS and Linux both have, in the C locale and UTC so
that every process reads the same text; it has a resolution of one second, and
two start times at most 3 seconds apart are the same one (the clock may be
stepped between two readings). A pid of 0 or 1 is never a run.
Events from before 0.6.0 have no `pidStart`: for those the pid alone decides,
and a reused pid still looks alive. If `ps` cannot say a process's start now,
the pid alone decides too.

### One run at a time: the queue

Several runs at once (an agent in each of three repositories, say) freeze
Docker, and the virtual machine behind it on a Mac. So every run of every
project on the machine takes its turn, first come first served, and a run
that finds the machine busy waits:

```text
Waiting for other-ci (pid 48213) · 1 ahead
...
Queue: your turn after 4m12s
ci-local 0.6.0: 12 steps, node 24.21.0, project myapp-ci, jobs: quality tests
```

The line is printed again only when whom the run waits for, or how many are
ahead, changes. A run that keeps waiting says so every 5 minutes, so a hang
shows:

```text
Still waiting for other-ci (pid 48213) · 1 ahead · 10m00s
```
 The run records the same in a `queued` event, so `--status`
shows it (`🚦 ◌ **ci-local** · queued · behind other-ci (1 ahead)`) from the
first moment, and nothing touches Docker, the runner or the development stack until the turn comes.
The `total` of the summary counts from the turn, not from the wait.

- **`--no-wait`**: when the machine is busy, print
  `ci-local: the machine is busy: <project> (pid <pid>)` on stderr and exit
  with status **3**, without waiting. The refused run records nothing: the
  project's events file, and so `--status`, still show its last run.
- **`CI_LOCAL_QUEUE_TIMEOUT=<seconds>`**: a run that has waited that long for
  its turn gives up. It removes its ticket, prints
  `ci-local: gave up waiting after 30m00s for <project> (pid <pid>)` on
  stderr and exits with status **3**, the status of `--no-wait`: in both the
  run got no turn and nothing ran, which is not a failure of its steps.
  The default, `0`, is no limit. The run ahead is left alone. The events file
  keeps the `queued` event, so `--status` shows the run as `stopped`, never
  started, like one interrupted while queued.
- **`CI_LOCAL_QUEUE_NOTICE=<seconds>`** sets how often the `Still waiting`
  line is printed (default `300`; `0`: never).
- **Ctrl-C or `kill` while waiting** removes the run from the queue and exits
  130 or 143, with no summary and no cleanup: the runner of that project may
  be the one in use by the run ahead.
- **`CI_LOCAL_QUEUE=off`** (also `0`, `false`, `no`) lets runs overlap, as
  before. It still records one `queued` event, so `--status` has no gap.
- **`--list`, `--print-plan`, `--down`, `--status`, `--help`, `--version`** do
  not queue.

How it works, for the curious or for a stuck queue: the directory
`CI_LOCAL_QUEUE_DIR` (default `~/.cache/ci-local/queue`, readable by you
alone; the `XDG_CACHE_HOME` and `TMPDIR` fallbacks are those of the events
file, and a path you set must be absolute) holds one ticket file per run,
named by the time it came and its pid (the ticket also holds its `pidStart`), and a `lock` directory made by the run
whose turn it is (`lock/pid` names it: its pid on the first line, its start
time on the second; versions before 0.6.0 read the first line alone, and
read a lock without the second as before). A run goes ahead when its ticket is
the first one of a live process and it makes the lock. Tickets and locks of
processes that are gone (killed, a crash, a reboot) are ignored and removed,
and a lock with no pid, which a crash between its two steps would leave, is
stale after 10 seconds; a lock whose process is alive is never removed. The
queue is polled every 2 seconds (`CI_LOCAL_QUEUE_POLL`, in seconds). If the
directory cannot be made, the run says so and goes on without waiting.

Without `XDG_CACHE_HOME` and `HOME` (a bare service account, say) the cache
is `$TMPDIR/ci-local-<uid>`, a fixed name in a shared directory. ci-local
makes it with mode 700, and refuses one that is already there and is not a
real directory of yours that no one else can write (a symlink, another
user's, or group- or world-writable): a run says so, and neither queues nor
writes events. `--status` refuses it too (status 2). `--list`, `--print-plan`
and `--down` use no cache, so they say nothing.

## In Pi: status line, end card and agent skill

The package is also a [Pi](https://pi.dev) package. Install it once, for every
repository:

```sh
pi install npm:@jals1212/ci-local
```

It needs Pi 0.84.3 or later (the `agent_settled` and
`session_compact_failed` events, entry renderers, and `PI_SESSION_ID` in the
bash tool).

In a session opened inside a repository with `ci-local.config.sh` (with a
literal `CI_PROJECT=`), it follows the events file of that project; it never
runs ci-local or Docker itself:

- **Status line**: `🚦 ◌ ci-local queued · behind erp-ci`, `🚦 ⧗ ci-local [3/8] lint · 2m05s`,
  then `🚦 ✓ ci-local passed · 4m12s` or `🚦 ✗ ci-local failed at lint · 2m10s` until
  the next run. A run already over when a session starts shows only while its
  result is undelivered, like an unread message: it ended with no session of
  the repository open. Once a session has shown it finished, a later session
  (new or resumed) leaves it out, and a reload keeps it out unless that
  session is the one that showed it. Each session records the last run it
  showed in its own file, under `<events file>.delivered.d/` (a file unused
  for 30 days is removed). A run in flight, and every later one, shows. Pi shows it in the footer. A shell that draws its own chrome
  shows it where it lists extension statuses: Gentle Shell, for one, under
  **Integrations** in the sidebar's Status card (or in its bottom bar on a
  narrow terminal).
- **Only the session's own runs** get the cards and the notification, and
  reach the agent: runs this session started. A run started from Pi's bash
  tool names its session (ci-local records Pi's `PI_SESSION_ID` as `session`
  in its events), wherever its process goes; one that names none, as a
  Gentle AI background job, is the session's when the pids above it, which
  it records at start (`ancestors`), include the session's process, so a run
  orphaned since (`nohup`, `setsid`) is still found; a run that recorded none
  (before 0.6.0) is the session's when its live process descends from the
  session's. The recorded pids are not checked against start times: if Pi's
  pid is given to another process later, an old run of the same events file
  could be taken for the session's, and its card shown once too often. A run started by another session in the same repository,
  or in a terminal, shows in the status line alone, as Gentle AI's
  background-job notices go only to the session that started the job.
- **When a run starts**: a card in the transcript when it is starting, or
  waiting for its turn (`🚦 ◌ ci-local · queued · behind erp-ci`), and another
  when its steps start (`🚦 ⧗ ci-local · running · [1/14] …`). They are for you
  only: session entries, never in the model's context, and not shown again
  after a reload.
- **When a run the session saw in flight ends**: a notification at once, and
  a card in the transcript with the `--status` block. The card says it comes
  from the extension, and reaches the agent the way Gentle AI hands a
  subagent's result to its parent:
  - **idle**: the card is stored in the conversation at once, without a
    turn; then one hidden message wakes the agent, 2 seconds after the run's
    process has exited (10 seconds after the card at most). When the run was
    started as a background job, that job's own exit notice usually wakes
    the agent first, and the card is already there: one reply covers both,
    and ci-local sends no wake;
  - **in a run** (busy): the card is steered in before its next model call,
    not once the whole task is over;
  - **busy without a run** (compacting): the card waits until the agent can
    take it.

  A delivery that fails is tried again (every 30 seconds, 3 times, then at
  the next turn boundary), never dropped. A run already over when the
  session starts is not announced.
- **Tool `ci_local_status`**: the same three lines for the agent, without a
  shell.
- **Skill `ci-local`**: how an agent runs and waits for ci-local (in the
  background (quiet without a terminal), never two runs, read only the failing
  step's log).
  Branch and merge policy stay the project's.

The extension follows the file ci-local would write: `CI_LOCAL_EVENTS` from
Pi's environment (a relative path is taken from the repository root, where
runs are started as a rule), else the cache. When runs write no events
(`CI_LOCAL_EVENTS=off`, or a `TMPDIR` fallback cache that is not a private
directory of yours), the extension follows nothing.

Outside Pi nothing changes: the extension, the skill and the optional Pi peer
dependencies are not used by `npx ci-local`.

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

### Environment variables

| Variable | Meaning |
| --- | --- |
| `CI_LOCAL_CONFIG` | The config file name, instead of `ci-local.config.sh`. |
| `CI_LOCAL_DOCKER_SOCK` | The Docker socket. Default: `/var/run/docker.sock`. |
| `CI_LOCAL_QUIET` | `0` or `false`: as `--live`; anything else not empty: as `--quiet`. Unset: quiet when stdout is not a terminal. |
| `CI_LOCAL_EVENTS` | A file: as `--events FILE`. `off`, `0`, `false` or `no`: no events file at all. |
| `CI_LOCAL_QUEUE` | `off`, `0`, `false` or `no`: no queue; runs may overlap. |
| `CI_LOCAL_QUEUE_DIR` | The queue directory (absolute). Default: `<cache>/ci-local/queue`. |
| `CI_LOCAL_QUEUE_POLL` | Seconds between two looks at the queue while waiting, above 0. Default: `2`. |
| `CI_LOCAL_QUEUE_TIMEOUT` | Whole seconds a run waits for its turn before it gives up and exits 3. `0`: no limit. Default: `0`. Not a whole number: status 2. |
| `CI_LOCAL_QUEUE_NOTICE` | Whole seconds between two `Still waiting for …` lines while waiting. `0`: none. Default: `300`. Not a whole number: status 2. |
| `XDG_CACHE_HOME`, `HOME`, `TMPDIR` | Where `<cache>` is: `$XDG_CACHE_HOME`, else `$HOME/.cache`, else `$TMPDIR/ci-local-<uid>`. |

Set in the environment, `CI_LOCAL_QUIET` and `CI_LOCAL_EVENTS` are a standing
preference: `--list`, `--print-plan` and `--down` ignore them without a
warning.

### Exit status

| Status | A run | `--status` |
| --- | --- | --- |
| 0 | Every step passed, and the development stack is untouched. | The last run passed. |
| 1 | A step failed, or the development stack changed. | It failed. |
| 2 | A usage or configuration error; nothing ran. | No run recorded (or an unusable cache, or `CI_LOCAL_EVENTS=off`). |
| 3 | `--no-wait` and the machine is busy, or `CI_LOCAL_QUEUE_TIMEOUT` ran out while waiting; nothing ran. | Queued, starting or running. |
| 4 | | Stopped: interrupted, or its process is gone without an end. |
| 130, 143 | Interrupted (Ctrl-C, `kill`). During the steps the summary still says `FAILED at step: interrupted`; while waiting in the queue nothing ran and nothing is printed. | |

## What it leaves on your machine

After a run, nothing but caches: the runner images (`ci-local-base:*`, and
`$CI_PROJECT-runner:*` when you extend it), and two volumes,
`$CI_PROJECT-npm-cache` and `$CI_PROJECT-cache` (`~/.cache`: Playwright browsers
and the like). The runner, `node_modules` (a volume: never your host's) and
everything labelled with `CI_LABEL` are removed, unless you passed `--keep`.

In your cache (`~/.cache/ci-local/`, see [Environment variables](#environment-variables)),
readable by you alone: one events file per project, `<project>.ndjson`,
replaced by the next run of the project, and the `queue` directory, empty
between runs. When quiet, each run's step logs stay in
`$TMPDIR/<project>-logs.XXXXXX` for you to read, until you or the system
clean `TMPDIR`.

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
