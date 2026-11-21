Weigh the instruction lines that call for a check: what each costs the sessions against what it has prevented

1. `await scripts.run("asked-to-run", { user: true })` lists the lines in AGENTS.md, CLAUDE.md, rules,
   agents, skills and fleet files, and in the user's own rules, that tell a session to run a check.
2. Split the lines into units: one bullet, numbered step, table row or paragraph that says must,
   never or always. For each, decide one of:
   - cut: a hook or CI enforces it and the session gains nothing from running it first; another
     line says the same; it describes a past incident rather than what to do; or it costs more
     than it prevented.
   - merge into the named line, or shorten to what a session must do.
   - move out of session-facing text into a script or a hook that enforces it, or into a reference
     file read on demand.
   - keep, with the evidence that it earns its place.
3. The cost of a line is what the check takes (CI median from `asked-to-run` or `timings`, or the
   timing report) times how often sessions run it. How often they ran it is in session history:
   `await ask.kit("mike", "How often did sessions run <command> in <repo> in the last 30 days, and
   how long did each wait?")`; label the figure "from session history".
4. What a line prevented is what the check caught: `catches` for the CI job that runs the same
   command, with the failures classified as in `audit-checks`. A line whose check has not failed in
   the window, and whose command CI also runs, is a cut or shorten candidate.
5. A line that carries an operator ruling (it names the operator and a date) may be shortened or
   merged, never dropped: list it under "for the operator" with the cost.
6. Never add a line. If a defect can only be prevented by adding one, say so in a note for the
   operator and name the line it would replace.
7. Answer with a list of lines (`path:line`), the decision for each, the cost and the evidence.
