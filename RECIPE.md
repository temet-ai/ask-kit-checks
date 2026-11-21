# Recipe: checks kit

## What it answers

What a repository's verification work costs and what it has caught: which checks exist and where
each is defined or triggered, how long each takes in CI, how often it failed and on what, which
overlap, which instruction lines tell a session to run a large or repeated check, and what could be
cut, merged, narrowed or shortened. It does that work when asked (edits to workflows, hooks and
instruction files) and never adds a check or a rule.

## What it needs

- `git` on PATH.
- Optional: `gh`, signed in, for CI history. The remote must be on GitHub. Without it every CI
  figure is reported as unavailable and the answer comes from the files.
- No keys and no build step.

## What it reads and runs

- Reads tracked and untracked files of the repository (`git ls-files -co --exclude-standard`):
  `.github/workflows`, `.husky`, `.githooks`, `lefthook.yml`, `.pre-commit-config.yaml`,
  `core.hooksPath`, `.git/hooks`, `package.json` scripts, `Makefile`, `.claude/settings*.json`
  (and `~/.claude/settings.json` hooks), and the instruction files (AGENTS.md, CLAUDE.md,
  CONTRIBUTING.md, `.claude/rules|agents|skills|fleet|commands`). Reads timing reports already on
  disk (JUnit XML, vitest and jest JSON).
- Runs `git config`, `git rev-parse`, `git ls-files`, and `gh run list`, `gh run view --json jobs`
  and `gh run view --log-failed` (at most 30 runs, logs of at most 6 failed runs). Any other `gh`
  command is refused by the module. It never runs a test, a build or a hook.

## Rebuild it from an empty folder

`ask-kit.toml` with a `CHECKS_ROOT` setting (`git rev-parse --show-toplevel`, else the working
folder), a `module` source `checks` and a `folder` source `repo` on that root with credentials,
`node_modules`, `target` and build output excluded, `acts = ["repo.edit", "repo.write", "repo.run"]`
(the folder source is read-only unless the ask may act), and one role `auditor`.

`checks.mjs` exports `make({settings, push, cwd, act})` returning `inventory`, `timings`, `catches`,
`overlaps`, `asked`, `verdict` and `brief.*` (the same results as one string per row, under the
4000-character clip the host puts on a value). Parts:

- `yaml.mjs`: a reader for the YAML subset workflows use (maps, lists, block scalars, flow lists).
- `commands.mjs`: splits shell text into commands, decides which are checks (cargo, npm/pnpm/yarn
  scripts, pytest, eslint, make targets, `scripts/*check*`...) and their kind (test, lint, format,
  typecheck, audit, build), normalises a command, and tells whole-project from narrow runs.
- `collect.mjs`: git hooks, Claude Code hooks, CI jobs and steps, package scripts and Makefile
  targets, instruction lines; and an expander that follows `npm test`, `make x` and `scripts/x`
  one level down so the same command is recognised under different triggers. A command in a
  subfolder (a step's `working-directory`, a nested AGENTS.md) keeps the folder in its key.
- `runs.mjs`: `gh run list` and `gh run view` per run (six at a time), per-job and per-step
  medians, p90, failures, trend; failing test names from `--log-failed` (nextest, cargo test,
  vitest, jest, pytest, go, node:test). Logs may show colour codes as the text `^[[31;1m`.
- `reports.mjs`: finds JUnit and vitest/jest JSON reports in the usual folders and lists the slowest
  tests.
- `verdict` candidates: merge (same command in two places), narrow (a hook over the whole
  project), shorten (an instruction line for what a hook or CI runs, or a repeated whole-project
  run), cut-or-narrow (10 or more runs, none failed, median 60 s or more), fix-cause (a format or
  lint check that fails in 30% of runs or more, or a step that failed on every run), keep, unknown.
  Jobs that ran in CI but are defined in no workflow file (GitHub's default CodeQL) get a row too.

Scripts `inventory`, `timings`, `catches`, `overlaps`, `asked-to-run` and `verdict` return the
`brief` forms. Skills in `skills/` and the role in `roles/` carry the method for weighing checks
(cut, narrow, merge, fix the cause, keep; evidence before removal; never add) and for weighing
instruction text (cut, merge, shorten, move, keep; a line that records a ruling by the person is
shortened, never dropped).

## Bench

`bench/questions.json`: five questions of kinds agents answer by hand about checks, put to the fixture in
`bench/fixture/guild` (a file, a line, a timing report), and three script runs. The marker file
`.ask-kit-checks-root` in the fixture makes the kit read it as a repository of its own, with no
remote. Questions about CI run history need a GitHub repository and are not in the bench.
