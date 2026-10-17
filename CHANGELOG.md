# Changelog

Each release of `@jals1212/ci-local`. Versions follow
[semantic versioning](https://semver.org); before 1.0.0 a minor version may add
options and a patch version fixes. Releases before 0.3.0 are described in
their `release x.y.z:` commit messages.

## 0.4.0

### Added

- `--status`: the state of the last run (running, passed, failed or stopped)
  as three lines of Markdown, from its events file: the step under way and
  how long it has run, or the failing step, its exit code and log, and
  whether the development stack was left alone. Exit status 0 passed,
  1 failed, 2 no run recorded, 3 running, 4 stopped. Needs no Docker; with
  `--events FILE`, no config either.
- Events by default: without `--events`, a run writes them to
  `~/.cache/ci-local/<project>.ndjson` (under `XDG_CACHE_HOME` when set) and
  names the file at the start; one it cannot write is a warning, not a
  stop. `CI_LOCAL_EVENTS=off` writes none.
- Event fields: `run` carries `version`, `pid`, `commit`, `args` and
  `logDir`; `start`, `ok` and `fail` carry the step's `log` with `--quiet`;
  `end` carries `devStack` (`untouched`, `changed`, `none`). Existing fields
  are unchanged.
- A machine-wide queue: runs of every project take their turn, first come
  first served, so Docker has one at a time. A run that has to wait prints
  `Waiting for <project> (pid <pid>) · <n> ahead` (again only when that
  changes) and `Queue: your turn after <time>`. `--no-wait` exits with the new
  status 3 (`ci-local: the machine is busy: ...`) instead of waiting;
  `CI_LOCAL_QUEUE=off` lets runs overlap; `CI_LOCAL_QUEUE_DIR` and
  `CI_LOCAL_QUEUE_POLL` name the directory (default
  `~/.cache/ci-local/queue`) and the polling interval. An interrupt while
  waiting leaves the queue and exits 130 or 143 with no cleanup; tickets and
  locks of dead processes are ignored.
- A `queued` event, written as soon as the run starts and again when whom it
  waits for changes (`project`, `version`, `pid`, `commit`, `args`, `logDir`,
  `ahead`, `blockedBy`), so `--status` never has a gap before the `run` event.
  `--status` shows `queued` (⏳) and `starting` (🐳), both with exit status 3.
- An events file still written by a live run of the same project is left to
  it: a second run takes it over only at its turn (without the queue, it
  writes no events and says so). Taking it (checking that no live run owns
  it, emptying it, writing the first event) happens in one step under a
  `<file>.claim` directory, so two runs that start together cannot both take
  it; a claim older than 10 seconds is a crashed run's and is broken.
- The `TMPDIR` fallback cache (`$TMPDIR/ci-local-<uid>`, used without
  `XDG_CACHE_HOME` and `HOME`) is refused when it already exists and is not a
  real directory of the user that no one else can write: the run neither
  queues nor writes events, and `--status` exits 2. Its `ci-local`
  directory is checked the same way once it exists, so one planted after
  the first check is caught before anything is written in it.
- A `<file>.claim` that cannot be made at all (an `--events` file in a
  directory the user cannot write) is given up at once, without waiting.
- The Pi extension takes a relative `CI_LOCAL_EVENTS` from the repository
  root, and follows nothing when the `TMPDIR` fallback cache is refused.
- README: where to install (the CLI in each repository, the Pi package once),
  keeping a machine's repositories on 0.4.x together, an environment variable
  reference, the exit statuses of a run and of `--status`, and the files
  ci-local leaves in the cache.
- A Pi package (`pi install npm:@jals1212/ci-local`): an extension that shows
  the run of the session's repository in the footer (queued, running with its
  step, then the result), notifies when a run it saw in flight ends and puts
  the `--status` block in the transcript (a follow-up for a busy agent, plain
  context for an idle one), plus a `ci_local_status` tool; and a `ci-local`
  skill with the rules for running and waiting on ci-local, without any
  branch policy. The Pi dependencies are optional peers.

### Changed

- Concurrent runs now wait their turn by default (see the queue above); use
  `CI_LOCAL_QUEUE=off` for the old behaviour.
- The `run` event is written when the run has its turn, after the `queued`
  event; the summary's total no longer counts the wait.
- Without `XDG_CACHE_HOME` nor `HOME` the cache is a private directory under
  `TMPDIR` (it used to be an error); directories ci-local creates in the
  cache have mode 700.

## 0.3.0

### Added

- `--quiet` (or `CI_LOCAL_QUIET=1`): each step's output goes to its own log
  file (`<TMPDIR>/<project>-logs.XXXXXX/NN-step-name.log`, printed at the
  start and kept), and the terminal gets only the step milestones, the summary
  and, when a step fails, the last 40 lines of its log. An interrupted step
  names its log.
- `--events FILE` (or `CI_LOCAL_EVENTS=FILE`): one JSON line per milestone,
  `run`, `start`, `ok`, `fail` and `end`, with `ts`, the step's name, index
  and total, `durationMs` and `exitCode`, so a run can be followed with
  `tail -f`. The file is emptied when the run starts; one that cannot be
  written stops the run before any step, with status 2.
- `--list`, `--print-plan` and `--down` warn on stderr that they ignore
  `--quiet` and `--events` given on the command line (not when set in the
  environment).
- README: "Following a run".

### Unchanged

- The default mode: every step's output still goes to the terminal live, with
  the `==>` / `<==` milestones. The summary, the `PASSED:` / `FAILED at
  step:` line, the cleanup and the development stack check print the same in
  every mode.
