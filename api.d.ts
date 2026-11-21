// A check is a command that tests, lints, type-checks, formats, audits or gates a repository. Each place that
// runs or asks for one is an entry: trigger "git-hook" | "claude-hook" | "ci" | "instruction" (a package script
// or Makefile target is a "definition": it is only run when something else calls it). `key` is the command in a
// normal form (env vars, ./ and colour flags removed) and `keys` adds what it expands to one level down
// (npm test -> the package script's command; make check -> its recipe; scripts/x -> the checks in the script),
// which is how the same command is found under different triggers.
interface CheckEntry { trigger: string; where: string; command: string; key: string; keys: string[]; kind: "test" | "lint" | "format" | "typecheck" | "audit" | "build" | "other"; runner: string; scope: "all" | "narrow"; [k: string]: any }

// Every call takes `folder` (default: the repository the agent works in; any folder inside a git repository works).
declare const checks: {
  root: string;
  act: boolean; // true when this ask may change things; nothing here changes anything: edits go through `repo`
  at(folder?: string): Promise<string>; // the repository's top folder

  // Where the checks are. counts: how many of each. gitHooks: core.hooksPath, .git/hooks, .husky, .githooks, lefthook,
  // pre-commit (narrowedToChangedFiles says whether the hook script looks at staged files). claudeHooks: the project's
  // and the user's .claude/settings*.json hooks that run a check (o.user false leaves the user's out). ci: each workflow
  // with its triggers, jobs (needs, matrix, runs-on) and the steps that run a check. definitions: package scripts and
  // Makefile targets. instructionLinesByFile: how many lines per instruction file tell a session to run a check.
  // notes: what was found missing (a hooks folder with only samples, a CI system it does not read).
  inventory(o?: { folder?: string; user?: boolean; max?: number }): Promise<{ folder: string; remote: string | null; counts: Record<string, number>;
    gitHooks: { hook: string; at: string; command: string; kind: string; scope: string; narrowedToChangedFiles: boolean }[];
    claudeHooks: { at: string; hookScope: string; command: string; kind: string; timeout: number | null; runs?: string[] }[];
    ci: { workflow: string; file: string; runsOn: string[]; triggers: string; jobs: { job: string; id: string; uses?: string; needs?: string[]; if?: string; matrix?: Record<string, number | string>; steps: number; checks: { step: string; runs: string[] }[] }[] }[];
    instructionLinesByFile: { file: string; lines: number }[]; definitions: { where: string; name: string; command: string; kinds: string[] }[]; definitionsCut: number; notes: string[]; next: string }>;

  // How long. CI: `gh run list` plus `gh run view --json jobs` for the last o.runs completed runs (default and maximum 30; o.workflow, o.branch, o.event
  // narrow them), per job: runs, failures, medianS, p90S, maxS, totalMin, trend (older half against newer half), slowestSteps. matrixFamilies pools
  // the variants of one matrix job. workflowWall is the median wall time of a whole workflow run. localReports: nextest/JUnit XML or vitest/jest JSON
  // already on disk, with the slowest tests and groups, how old the file is, and the sum of per-test seconds. source and notFound say where each
  // number came from and what could not be found. Without gh or a GitHub remote, ci.unavailable says why.
  timings(o?: { folder?: string; runs?: number; workflow?: string; branch?: string; event?: string; jobs?: number; top?: number; reports?: number; reportFiles?: string[] }): Promise<{
    folder: string; source: { ci: string | null; localReports: string[] };
    ci: { runs: number; window: { from: string; to: string }; slowestJobs: { workflow: string; job: string; runs: number; failures: number; cancelled: number; skipped: number; medianS: number | null; p90S: number | null; maxS: number | null; totalMin: number; trend: string | null; slowestSteps: { step: string; medianS: number | null; runs: number; failures: number }[] }[]; jobsCut: number; totalMinutes: number; matrixFamilies: any[]; workflowWall: { workflow: string; runs: number; medianS: number }[] } | { unavailable: string };
    localReports: { file: string; ageDays: number; tests: number; failed: number; sumOfTestSeconds: number; slowest: { test: string; s: number }[]; slowestGroups: { group: string; tests: number; s: number }[]; failedTests: string[] }[]; notFound: string[] }>;

  // How often each failed, and on what. failingJobs: runs, failures, failRate, failedSteps (name, kind from the name: format | lint | typecheck | test |
  // build | setup | other, count), recent failures with run id, date and title. failedRunDetail: for the o.logs (default 3, at most 6) newest failed
  // runs, the failing test names and error lines from `gh run view --log-failed`. neverFailed: jobs with no failure in the window, slowest first.
  catches(o?: { folder?: string; runs?: number; workflow?: string; branch?: string; event?: string; logs?: number; max?: number }): Promise<{
    folder: string; source: string; runsByConclusion: Record<string, number>;
    failingJobs: { workflow: string; job: string; runs: number; failures: number; failRate: string; failedSteps: { step: string; kind: string; n: number }[]; recent: { run: number; at: string; title: string; event: string }[] }[]; failingJobsCut: number;
    failedRunDetail: { run: number; workflow?: string; at?: string; step?: string | null; tests?: string[]; moreTests?: number; errors?: string[]; why?: string }[];
    neverFailed: { workflow: string; job: string; runs: number; medianS: number | null; totalMin: number }[]; neverFailedCut: number; cancelledOrSkipped: string[]; caution: string } | { folder: string; unavailable: string }>;

  // The same command under more than one place (hook, CI step, Claude hook, instruction line), found through expansion too: `npm test` in CI and the
  // package script's command in a hook meet. containedInBroaderRun: a whole-project run of a tool beside narrower runs of the same tool.
  overlaps(o?: { folder?: string; user?: boolean; max?: number }): Promise<{ folder: string;
    sameCommandUnderSeveralPlaces: { command: string; triggers: string[]; places: number; scope: string; kind: string; at: { trigger: string; where: string; via?: string }[]; atCut: number }[]; cut: number;
    containedInBroaderRun: { runner: string; broad: { command: string; trigger: string; where: string }; narrower: { command: string; trigger: string; where: string }[]; note: string }[];
    counts: { checksSeen: number; commandsInSeveralPlaces: number; underDifferentTriggerKinds: number }; caution: string }>;

  // Instruction lines (AGENTS.md, CLAUDE.md, CLAUDE.local.md, CONTRIBUTING.md, .claude/rules, agents, skills, fleet) that tell a session to run a check, grouped by
  // command: where (path:line, the line), heavy (it covers the whole project), repeated (the line says every, each, always, again, before each push...), alsoRunBy
  // (hooks and CI that run the same command) and ciMedianS (from CI step timings when the same command is a CI step). Lines that name a check to forbid it are left out.
  // o.user true adds ~/.claude/CLAUDE.md and ~/.claude/rules; o.cost false skips the gh lookup.
  asked(o?: { folder?: string; user?: boolean; cost?: boolean; max?: number; runs?: number }): Promise<{ folder: string; filesRead: number; linesWithACheck: number; distinctCommands: number; heavyAndRepeated: number; alsoRunElsewhere: number;
    commands: { command: string; kind: string; scope: string; heavy: boolean; repeated: boolean; lines: number; at: { at: string; line: string; fileScope: string; repeated?: boolean }[]; atCut: number; alsoRunBy: string[]; ciMedianS: number | null; costFrom: string | null }[]; cut: number; notes: string[] }>;

  // One row per distinct check with its cost, catches and overlaps, and candidates (merge | narrow | shorten | cut-or-narrow | fix-cause | keep | unknown), each
  // with the reason. Candidates only: the investigator reads the evidence and judges. o.ci false skips CI history.
  verdict(o?: { folder?: string; user?: boolean; ci?: boolean; runs?: number; max?: number }): Promise<{ folder: string; source: string; checks: number; candidates: Record<string, number>;
    rows: { check: string; kind: string; scope: string; triggers: string[]; places: number; where: string[]; alsoReachedBy: string[]; ci?: { level: "step" | "job"; runs: number; failures: number; medianS: number; totalMin: number; failedOn: { run: number; at: string; title: string }[]; note?: string };
      candidates: { action: string; reason: string }[] }[]; cut: number; caution: string }>;
};
