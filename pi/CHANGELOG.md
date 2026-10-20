# Changelog

Each release of `@jals1212/ci-local-pi`. Versions follow
[semantic versioning](https://semver.org); before 1.0.0 a minor version may
add or change behaviour and a patch version fixes.

## Unreleased

## 0.3.1

### Fixed

- A `ci-local.config.sh` written after the session started is now followed:
  `ci_local_run`, or the end of a turn, sets up the status line, the cards and
  the end card, which before came only after a `/reload`. When nothing can
  follow the run (no UI, or no events file), `ci_local_run` no longer promises
  a footer or an end card. (#51)

## 0.3.0

### Changed

- Status line: a `·` separates the name from the state, as other footer
  integrations do (`🚦 ci-local · ✓ passed · 4m12s`, was
  `🚦 ci-local ✓ passed · 4m12s`). (#45)

## 0.2.0

### Added

- Tool `ci_local_run`: starts a run of the repository's own ci-local
  (`node_modules/.bin`, else `PATH`) detached from Pi, for this session.
  (#42, #43)
  - It returns once the run is queued or started, or with ci-local's output
    when it ends first (`--list`, a usage or config error, `--no-wait` on a
    busy machine).
  - No background job, so no job notice: the footer and the end card report
    the run.
  - A launch that ends after the tool returned, without the session ever
    seeing its run, gets an end card of its own with the end of its output.
  - Launch outputs live under `$TMPDIR` and are removed after a week.
- Skill: starts runs with `ci_local_run` when present. (#42)

### Changed

- Status line: the state's glyph sits by the state, after the name
  (`🚦 ci-local ✓ passed · 4m12s`, was `🚦 ✓ ci-local passed`). (#40)
- Status line: a queued run says how many runs are ahead of it and which one
  is running (`🚦 ci-local ◌ queued · 2 ahead (erp-ci running)`). It said
  only `behind erp-ci`, the run at the head of the queue, so every waiting
  session read the same. (#40)

## 0.1.1

### Changed

- The bridge role is gone from the extension: the CLI 0.8.0 no longer has a
  bridge. The flag that keeps a CLI 0.7.x bridge quiet while this package is
  loaded stays. (#35)

## 0.1.0

### Added

- First release as its own package; until now it shipped inside
  `@jals1212/ci-local` (0.4.0–0.6.x). (#35)
