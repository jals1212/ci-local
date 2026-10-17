# Changelog

Each release of `@jals1212/ci-local`. Versions follow
[semantic versioning](https://semver.org); before 1.0.0 a minor version may add
options and a patch version fixes. Releases before 0.3.0 are described in
their `release x.y.z:` commit messages.

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
  `tail -f`. The file is emptied when the run starts.
- README: "Following a run".

### Unchanged

- The default mode: every step's output still goes to the terminal live, with
  the `==>` / `<==` milestones. The summary, the `PASSED:` / `FAILED at
  step:` line, the cleanup and the development stack check print the same in
  every mode.
