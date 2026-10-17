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
