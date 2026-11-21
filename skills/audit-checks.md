Audit a repository's verification work: find the checks that cost more than they have found

1. Name the repository: the caller's folder, or the folder the question names. Say which.
2. `await scripts.run("inventory")`. Note where checks are triggered: git hooks, Claude Code hooks,
   CI, and instruction lines. Note what is missing; a hooks folder that holds only samples means no
   local hook runs.
3. `await scripts.run("timings")`. Note the three slowest jobs and their slowest steps, the number of
   runs and the dates. A matrix job's variants run in parallel: the family total is minutes of
   runner time, the median is what a person waits for. If a timing report is on disk, name the ten
   slowest tests; they are a report, and its age is in `ageDays`.
4. `await scripts.run("catches")`. For each job that failed, note which step and, from the log, which
   tests or which error. Classify each failure: a product defect, or maintenance (format, lint
   rules, snapshots, fixtures, lockfiles, setup, an environment fault). Only a product defect that
   only this check found justifies its cost. A job that fails on every run is either broken or being
   ignored: say which the log shows.
5. `await scripts.run("overlaps")` and `await scripts.run("asked-to-run")`. Note commands that run in
   two places, and instruction lines that call for a whole-project or repeated run, especially where
   CI already runs it.
6. `await scripts.run("verdict")` ties the three together. For each row you keep as a candidate,
   check it against steps 3 to 5. Drop a candidate whose failures were product defects.
7. For waiting that sessions did, ask mike: `await ask.kit("mike", "In <repo>, how often did sessions
   run <the command> in the last 30 days and how long did each wait?")`. Put the answer under "from
   session history". If the caller wants the operator's own words on slow tests or gates, ask mike
   for them with dates; a recorded objection outranks a repository rule that contradicts it.
8. Decide for each check, in these terms: cut (nothing reads it, or its failures were all
   maintenance), narrow (keep representative cases: one size, one package, the changed files),
   merge (two places run the same thing: keep one), fix the cause (it fails on every run, or a
   formatter failure keeps breaking CI), or keep with the evidence that it caught something.
   A product constraint (license, security, policy) is kept unless named.
9. Answer: the table of candidates (check, cost with source, failures with classification, overlap,
   action), then what you could not measure, then notes for the operator. Say how many runs and
   which dates each number covers; never claim a check "never fails", only that it did not in the
   window.
