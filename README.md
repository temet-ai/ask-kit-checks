# ask-kit-checks

An [ask-kit](https://github.com/temet-ai/ask-kit) kit that lets your coding agent's `ask` tool
answer what a repository's checks cost and what they have caught: which checks exist and where each
is defined, how long they take in CI, how often they failed and on what, which run the same command
in more than one place, and which instruction lines tell a session to run something large. A cheap
model reads the repository's files and its recent GitHub CI runs outside your agent's context, and
removes, merges, narrows or shortens checks when asked. It never runs a test, a build or a hook to
measure it.

Questions from its bench:

- Which git hooks does this repository define, and what does each run?
- Do two CI workflows run the same check command?
- Which test was slowest in a nextest timing report, and how long did it take?

## Install

You need [ask-kit](https://github.com/temet-ai/ask-kit#set-it-up) and `git`. CI numbers also need
the GitHub CLI `gh`, signed in, and a repository on GitHub; without them the kit answers from the
files and says that no CI history was read.

Paste this into your agent:

```
Read ~/.config/ask-kit/AGENTS.md, then add this kit: github.com/temet-ai/ask-kit-checks
```

Or run it yourself:

```sh
ask-kit kit install temet-ai/ask-kit-checks        # shows what it reads, changes and runs
ask-kit kit install temet-ai/ask-kit-checks --yes  # installs and enables it
```

Restart your agents so `ask` lists `checks`. The kit answers about the repository your agent works
in; a question that names another folder is answered there.

## What it carries

| | |
|---|---|
| Scripts | `inventory` (every check and where it is defined or triggered: git hooks, Husky, lefthook, Claude Code hooks, CI jobs and steps, package scripts, Makefile targets), `timings` (CI time per job and step over the last 30 runs; slowest tests from a timing report on disk), `catches` (failures per job and step, failing test names from the newest failed runs, jobs that did not fail in the window), `overlaps` (the same command under several triggers; whole-project runs beside narrower ones), `asked-to-run` (instruction lines that tell a session to run a check, with `path:line` and CI cost), `verdict` (one row per check with merge, narrow, shorten, cut-or-narrow, fix-cause, keep or unknown candidates) |
| Skills | `audit-checks`, `cut-a-check`, `narrow-a-hook`, `shorten-instruction`, `weigh-instruction-lines`: playbooks the investigator loads when the job calls for one |
| Roles | `auditor` for requests to audit a repository's checks or to cut them |

Each script also runs with no model: `ask-kit run checks timings`, or `ask(do: "checks.timings")`
from an agent. For how often sessions ran the whole suite and how long they waited, the investigator
asks the `mike` kit and labels that part of the answer as from session history; this kit does not
read session history itself.

A check is weighed by
what it costs against what it has caught, and the result is cut, merge, narrow, shorten, fix the
cause, or keep. It does not add checks or rules.

## What it can change

A question changes nothing. When the request asks for a change, the investigator can edit and
write files in the repository and run programs there (`repo.edit`, `repo.write`, `repo.run`, held
back by ask-kit unless the caller passed `act: true` or opened the request with what to do). Its
playbooks use that to remove a duplicated step, narrow a hook to the changed files and delete or
shorten an instruction line, and they tell it to show the surviving check before removing one, show
`git diff`, and not run the workflow or the suite.

`checks.mjs` itself changes nothing. It calls `gh` only as `run list` and `run view` and refuses
every other `gh` command. What the investigator reads goes to a model: the `repo` source excludes
`.env*`, key and token files, `node_modules`, `target` and other build output. CI logs are read
only for the newest failed runs (three by default) and only their test names and error lines are
kept.

## How well it works

`bench/questions.json` holds five questions and three script runs against the fixture in `bench/fixture/guild`, each with patterns its answer
must hold. They have not been run on a model; `ask-kit kit test checks` runs them from the kit's folder. The six scripts
were run on a Rust and Svelte workspace and on an npm package with a three-system CI matrix, four
of them on a Rust workspace without CI, and their output read.
