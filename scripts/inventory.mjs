export const meta = {
  purpose:
    "Every check a repository has and where each is defined or triggered: git hooks (core.hooksPath, .git/hooks, .husky, lefthook, pre-commit), Claude Code hooks that run a check, CI workflows with their jobs and the steps that run a check, package scripts and Makefile targets, and how many instruction lines tell a session to run one. Says what it found missing (a hooks folder holding only samples).",
  params: { folder: "optional (default: the caller's repository)", user: "include the user's ~/.claude/settings.json hooks, default true", max: "list length, default 60" },
  returns: "{folder, remote, counts, gitHooks[], claudeHooks[], ci[{workflow, file, triggers, jobs[{job, needs, matrix, checks[{step, runs}]}]}], instructionLinesByFile[], definitions[], notes[]}",
  example: 'await scripts.run("inventory", { folder: "/path/to/repo" })',
};
export default async function ({ checks }, p = {}) {
  return checks.brief.inventory(p);
}
