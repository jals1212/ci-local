---
name: ci-local
description: "Trigger: ci-local, run CI locally, ci-local.config.sh, CI_PROJECT, ci-local --status, ci_local_status, local CI failed, parity test. Run and follow @jals1212/ci-local runs without wasting the wait or the machine."
license: MIT
metadata:
  author: jals1212
  version: "0.2.0"
---

## Activation Contract

Use when running, waiting on, reading, or configuring `ci-local` (`npx ci-local`, `pnpm exec ci-local`) in a repository with `ci-local.config.sh`. Branch, merge and PR policy are the project's, not this skill's: follow the repository's own docs or the user.

## Hard Rules

- Run the repository's own ci-local (`npx ci-local`, `pnpm exec ci-local`), never a global install: the version is the repository's.
- Start a run with the `ci_local_run` tool when present: it returns once the run is queued or started, and its end card reaches you when it ends. Without it, launch in the background (`bash_background` or equivalent) and wait for its exit notice. Never poll, never `sleep`.
- Unwatched runs are quiet: milestones and the summary on stdout, each step's output in its own log. From 0.5.0 that is the default without a terminal; before 0.5.0, add `--quiet`. Never add `--live` to a background run.
- Do not touch the checkout while a run is in flight (no edits, no branch switch): the steps read it.
- Never start a second run to "check" the first. Runs queue machine-wide by themselves (one Docker user at a time); a waiting run is normal, not a hang.
- Read the result from the run itself: `PASSED:` / `FAILED at step:` and `Development stack untouched`. A changed development stack is a failure.
- On failure, read only the failing step's log (named in the failure output or `--status`), not every log.
- Everything a run creates carries the `$CI_PROJECT` prefix and the `$CI_LABEL` label; never hard-code another name, publish a port, or reuse a development container name. Local compose smokes use `-p <own-name>`.

## Decision Gates

| Need | Action |
| --- | --- |
| State of a run (queued, running, result) | `ci_local_status` tool if present; else `ci-local --status` (3 lines, no Docker) |
| Pi extension active (footer shows `ci-local`) | Do not print waiting or completion blocks: the footer and the end card already do |
| `ci_local_run` ended at once (`exited`) | Its output is the result: a usage or config error, `--list`, or a busy machine with `--no-wait` |
| No extension | Paste the `ci-local --status` output once when the run starts and once when it ends |
| Only some jobs | `--only JOBS` / `--skip TAGS`; a partial run never stands for the full one |
| Inspect containers after a run | `--keep`, then `ci-local --down` |
| Machine busy and you cannot wait | `--no-wait` (exit 3 when busy) and tell the user |
| Config or plan changed | Run the repository's parity test (`@jals1212/ci-local/parity`) before the full run |

## Execution Steps

1. Check the plan: `ci-local --list`.
2. Start: `ci_local_run` (arguments in `args`); without it, `ci-local` in the background (`ci-local --quiet` before 0.5.0).
3. While waiting, keep working on something that does not touch the checkout, or report the `--status` block.
4. On exit: status 0 passed, 1 failed, 2 usage/config error, 3 no turn (busy with `--no-wait`, or `CI_LOCAL_QUEUE_TIMEOUT` reached).
5. Failed: open the failing step's log, fix, and run again; partial `--only` runs are fine while fixing, the final check is a full run.

## Output Contract

Report: project, commit, result line (`PASSED` / `FAILED at step`), total time, any `DEVIATES` lines, and whether the development stack was untouched.

## References

- Package README, "Following a run" and "One run at a time: the queue": events, `--status` states and exit codes.
