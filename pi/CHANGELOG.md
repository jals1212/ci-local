# Changelog

Each release of `@jals1212/ci-local-pi`. Versions follow
[semantic versioning](https://semver.org); before 1.0.0 a minor version may
add or change behaviour and a patch version fixes.

## Unreleased

### Added

- Tool `ci_local_run`: starts the repository's own ci-local
  (`node_modules/.bin`, else `PATH`) detached, named for the session, and
  returns once the run is queued or started, or with its output when it ends
  first (`--list`, a usage or config error). No background job, so no job
  notice next to the end card. A launch that ends later without the session
  ever seeing its run gets a failed end card with the end of its output.
  Launch outputs live under `$TMPDIR` and are removed after a week. The skill starts
  runs with it when present.

### Changed

- Status line: the state's glyph sits by the state, after the name
  (`🚦 ci-local ✓ passed · 4m12s`, was `🚦 ✓ ci-local passed`).
- Status line: a queued run says how many runs are ahead of it
  and which one is running (`🚦 ci-local ◌ queued · 2 ahead (erp-ci running)`,
  was `behind erp-ci`): the run named is the one at the head of the queue, the
  same for every run waiting, so two waiting sessions read alike before.

## 0.1.1

### Changed

- The bridge role is gone from the extension: the CLI 0.8.0 no longer has a
  bridge. The flag that keeps a CLI 0.7.x bridge quiet while this package is
  loaded stays. (#35)

## 0.1.0

### Added

- First release as its own package; until now it shipped inside
  `@jals1212/ci-local` (0.4.0–0.6.x). (#35)
