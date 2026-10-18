# Changelog

Each release of `@jals1212/ci-local`. Versions follow
[semantic versioning](https://semver.org); before 1.0.0 a minor version may add
options and a patch version fixes. Releases before 0.3.0 are described in
their `release x.y.z:` commit messages.

## Unreleased

### Added

- Events: the `queued` and `run` events carry `schema` (`1`), the version of
  the events contract, which the README now states: fields are only added
  within a version; removing one or changing its meaning raises `schema`.
  `--status` and `runState` expose it (`null` for events from before it). (#35)
- `@jals1212/ci-local/status` is a supported entry point, with types
  (`status.d.ts`): `lastRun`, `runState`, `render` and the helpers behind
  them, for readers of the events file such as the Pi extension. (#35)

## 0.6.0

### Added

- Queue: `CI_LOCAL_QUEUE_TIMEOUT` (whole seconds, default `0`: no limit). A
  run that has waited that long for its turn removes its ticket, prints
  `ci-local: gave up waiting after <time> for <project> (pid N)` on stderr
  and exits with status 3, the status of `--no-wait`: the run got no turn
  and nothing ran. (#2)
- Queue: a waiting run prints `Still waiting for <project> (pid N) · <n>
  ahead · <time>` every `CI_LOCAL_QUEUE_NOTICE` seconds (default 300; `0`:
  never), so a hang behind it shows. The `Waiting for` line on a change is
  kept. (#2)
- A wrong `CI_LOCAL_QUEUE_TIMEOUT` or `CI_LOCAL_QUEUE_NOTICE` (not a whole
  number of seconds) is a usage error, status 2, before anything is queued.
- Deviations: the `start`, `ok` and `fail` events of a step marked
  `--deviates` carry `deviates` (the reason), and `end` carries `deviations`
  (how many such steps started; `0` when none). A passed `--status` block,
  and so the Pi end card, adds `· 1 deviation (pnpm run test:integration)`
  to its last line (`2 deviations (a, b)`; from three, the first two and `…`).
  Events from before this show as they did. (#18)
- The `queued` and `run` events carry `ancestors`: the pids above ci-local
  when it started, its parent first, up to but not with pid 1, at most 32
  (`[]` when `ps` cannot say). (#20)

### Fixed

- A reused pid no longer makes a dead run look alive. The `queued` and `run`
  events, the queue tickets and `lock/pid` record the process's start time
  (`pidStart`, from `ps -o lstart=` in the C locale and UTC) next to its pid,
  and a pid that started at another time counts as gone: `--status` and the
  Pi status line show the run as stopped, the next run takes over its events
  file, and its ticket and lock are ignored. Two start times count as the
  same when they are at most 3 seconds apart, so a clock stepped by NTP does
  not make a live run look gone; a start time that cannot be read as a date
  cannot tell, so the pid alone decides. Pids 0 and 1 are never a run (`kill -0 0`
  reaches the whole process group): they count as gone. `--status` and the Pi
  status line keep a start time read from `ps` for 5 seconds instead of
  asking every second. Events and tickets without a start time (older runs)
  keep the pid-only check. `lock/pid` has the pid on its first line, as
  before, and the start time on its second. (#3)
- Pi extension: a run orphaned since it started (`nohup`, `setsid`, a Gentle
  AI background job) is now the session's own. A run that names no session
  is the session's when its recorded `ancestors` include Pi's process; one
  with none recorded (before 0.6.0) is still decided by its live process
  tree. The pids are not checked against start times, so a reused pid of Pi
  could, rarely, show an old run's card once too often. (#20)

## 0.5.3

### Fixed

- A TMPDIR fallback cache that is not private (neither `XDG_CACHE_HOME` nor
  `HOME` set) is now said only by a real run and by `--status`, which still
  exits 2. `--list`, `--print-plan` and `--down` use neither events nor queue,
  and no longer print the warning.
- Test: the queue test `two runs: the second waits…` (flaky once in about 43
  runs) no longer orders the two runs by the millisecond timestamps of two
  processes. It reads B's run event, and then checks that A's end is already
  in A's file. Its wait for a step to start is 30 seconds, not 15. Its failure
  output is kept for the next time it fails.

### Changed

- Tests: the Pi extension's glue (`extensions/ci-local.ts`) is covered, with a
  stand-in Pi and mock timers (Node 22.6 and later): one notification and one
  end card per run seen in flight, delivery for an idle agent (stored, then one
  hidden wake) and for an agent in a run (steered in), start cards, a run of
  another session (status line only), the card renderers and the
  `ci_local_status` tool.
- `bin/ci-local`: a comment at `queue_lock` records why removing a stale lock
  by check-then-move is safe today, and that a change letting two runs try
  the lock at once needs a compare-and-move. No change in behavior.

## 0.5.2

### Fixed

- Pi status line: after a reload, a run the session had left out at its start
  (already delivered by another session) stays out; before, it showed again.
  Each session now records the runs it showed in its own file, under
  `<events file>.delivered.d/`, so two sessions that see a run end at once
  never overwrite each other; a file unused for 30 days is removed. The
  0.5.1 marker (`<events file>.delivered`) still reads.
- Pi extension: the status line's logic moved to `core.js`
  (`createStatusLine`), tested across sessions and reloads; a new test loads
  the extension itself with a stand-in Pi (Node 22.6 and later).

### Changed

- Releases: the release workflow also creates the GitHub release of the
  tag, with the version's section of this file as its notes.

## 0.5.1

### Fixed

- Pi status line: a session that starts no longer shows a run whose result
  a session already showed (`🚦 ✓ ci-local passed · 12m14s` from an earlier
  session). A run that ended with no session of the repository open is still
  shown, once, like an unread message; a marker next to the events file
  (`<events file>.delivered`) records the last run delivered. A run in flight,
  a run that ends later, and a reload show as before.

### Changed

- README: the Pi package needs Pi 0.84.3 or later.

## 0.5.0

### Changed

- A run is quiet by default when stdout is not a terminal (an agent, a
  background job, a pipe): each step's output goes to its own log file, and
  stdout gets the milestones, the summary and the end of a failing step's
  log, as with `--quiet`. In a terminal, nothing changes: the output is live.
  `CI_LOCAL_QUIET=0` and the new `--live` keep it live without a terminal
  (`ci-local --live | tee run.log`); the last of `--live` and `--quiet` on
  the command line wins. `--status` refuses both; `--list`, `--print-plan`
  and `--down` ignore `--live` with a warning, as they do `--quiet`.
- The `ci-local` skill no longer asks for `--quiet` (0.5.0 and later).

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
  `--status` shows `queued` (◌) and `starting` (⧗), both with exit status 3.
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
- Where no `<file>.claim` can be made at all (a writable `--events` file in
  a directory the user cannot write), the file is taken without a claim, as
  before 0.4.0. A stale claim that cannot be removed is given up at once
  (the run writes no events and says so) instead of being retried forever.
- The Pi extension takes a relative `CI_LOCAL_EVENTS` from the repository
  root, and follows nothing when runs write no events (`CI_LOCAL_EVENTS=off`,
  or a refused `TMPDIR` fallback cache) instead of showing an old run (#4);
  `ci-local --status` says so and exits 2 instead of showing one.
- With `--quiet`, an `--events` file that cannot be written (status 2) no
  longer leaves an empty step-log directory in `TMPDIR`.
- The Pi end card reaches the agent as Gentle AI hands a subagent's result
  to its parent: an idle agent gets it stored at once, without a turn, and
  one hidden wake 2 seconds after the run's process has exited, so a run
  started as a background job is covered by one reply with that job's exit
  notice; an agent in a run gets it steered in before its next model call;
  busy without a run (compacting) it waits. A delivery that fails is retried
  (every 30 seconds, 3 times, then at the next turn boundary), never
  dropped.
- The Pi extension announces only the session's own runs: a run that names
  the session (ci-local records Pi's `PI_SESSION_ID` as `session` in its
  `queued` and `run` events), or, naming none, one whose process descends
  from the session's: cards, notification and the agent. Another
  session's run in the same repository, or a terminal's, updates the status
  line alone. Two Pi sessions in one repository each got the other's end
  card before.
  When `ps` cannot tell a live run's parents, the run counts as the
  session's own: a card shown twice rather than one lost.
- Pi start cards: when a run is starting (or waiting for its turn) and when
  its steps start, a card in the transcript for the user only (session
  entries, never in the model's context, not repeated after a reload).
- The state marks of `--status`, the Pi cards and the status line are one
  column wide, as Gentle Shell's own: `◌` queued, `⧗` starting or running,
  `✓` passed, `✗` failed, `⊘` stopped (emoji are two columns wide, and some
  terminals draw them badly).
- ci-local's own emoji, 🚦, before the state mark in `--status`, the Pi
  cards and the status line (`🚦 ⧗ ci-local [3/8] lint · 2m05s`), as Engram
  has 🧠 and RDD 🌹 in Gentle Shell. One emoji per line, always first; the
  state marks stay one column wide.
- README: where the Pi status line shows (Pi's footer; Gentle Shell's
  sidebar, under Integrations).
- `CI_LOCAL_QUEUE_POLL` of 0 falls back to 2 seconds instead of a busy loop.
- The Pi end card tells the model it comes from the ci-local extension;
  without that line a model took the bare block for a message from the
  user. The transcript shows the card as before.
- README: why the time in `--status` and the card (to the end of the
  cleanup) differs from the summary's `total` (the steps alone).
- `status.js` can be imported by a process whose `argv[1]` is no file
  (`node -e`, an embedder) without throwing (#5).
- A run refused by `--no-wait` records nothing, so `--status` keeps showing
  the project's last run (#6).
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
