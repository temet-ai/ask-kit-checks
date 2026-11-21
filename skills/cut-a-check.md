Remove or merge a duplicated check safely; only when the caller asked for the change

1. Name the check and every place it runs: `await scripts.run("overlaps")` and, for one command,
   `await repo.rg("<command>", { fixed: true, hidden: true })`. Include CI workflows, git hooks,
   `.claude/settings*.json`, Makefile targets, package scripts and instruction lines.
2. Decide which place stays: the one that runs earliest for the person making the change, or the
   one that is required to merge. A check that runs only in CI on a pull request cannot replace a
   local check the instructions rely on; say so.
3. Show what still covers the case before removing anything: the surviving place, its path:line,
   the command, and what triggers it. If nothing covers it, stop and report that.
4. Read the file (`repo.read`) and make the smallest edit with `repo.edit`: one step, one job, one
   hook line, one target. A workflow job that other jobs list under `needs` stays until those lines
   are changed in the same edit.
5. If a workflow, hook or script refers to the removed check in a comment, a skill or an instruction
   line, `repo.rg` the command name and remove those lines too, or the removal comes back as a
   rule.
6. Show `git diff` for each file. Do not run the workflow, the hook or the suite. Do not add a
   replacement check, a note or an approval step.
7. Answer with each file, line and removed text, what still covers the case, and the numbers that
   justified the cut (cost and failures, with source and window).
