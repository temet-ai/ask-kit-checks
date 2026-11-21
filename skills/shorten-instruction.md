Delete or shorten an instruction line that calls for a redundant or repeated full run; only when the caller asked for the change

1. Find the lines: `await scripts.run("asked-to-run")` gives each command with `path:line`, whether it
   covers the whole project (`heavy`), whether the line asks for it repeatedly (`repeated`), and
   what else runs it (`alsoRunBy`).
2. For each line you consider, read the file around it with `repo.read`. Decide:
   - CI or a hook already runs the same command, and a session gains nothing from running it first:
     delete the line.
   - The line asks for a full run before every step: shorten it to one run, once, before handing
     the work over, and keep the narrow command (one package, one test file, the changed files) for
     the steps in between.
   - The line carries something the operator said (it names the operator and a date): shorten it,
     never delete it, and list it for the operator with the cost you measured.
3. The same command often sits in several files (AGENTS.md, CLAUDE.md, a rules file, an agent
   brief, a skill, a fleet file). Change all of them in one pass or it comes back: `repo.rg` the
   command and apply the same decision to each hit.
4. Edit with `repo.edit`; show `git diff` for each file. Do not add a replacement line, a rule or a
   procedure. If two lines said the same, the surviving one is the one in the file that loads
   earliest for the session.
5. Finding and merging rule text in general (which rules exist, how many, contradictions) belongs to
   the rules kit: `await ask.kit("rules", "...")`.
6. Answer with each file, line and removed or shortened text, the surviving line, and the evidence
   (cost from CI or from session history, and what else runs the command).
