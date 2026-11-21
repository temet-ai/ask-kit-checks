export const meta = {
  purpose:
    "The instruction lines in AGENTS.md, CLAUDE.md, CLAUDE.local.md, CONTRIBUTING.md, .claude/rules, agents, skills and fleet files that tell a session to run a check: the command, path:line, whether it covers the whole project, whether the line asks for it repeatedly, which hook or CI step also runs it, and its CI median seconds when the same command is a CI step. Lines that forbid a command are left out.",
  params: { folder: "optional", user: "also read ~/.claude/CLAUDE.md and ~/.claude/rules, default false", cost: "look up CI timings for the cost, default true", max: "commands listed, default 30" },
  returns: "{folder, filesRead, linesWithACheck, distinctCommands, heavyAndRepeated, alsoRunElsewhere, commands[{command, kind, scope, heavy, repeated, lines, at[{at, line}], alsoRunBy[], ciMedianS, costFrom}], notes[]}",
  example: 'await scripts.run("asked-to-run", { folder: "/path/to/repo" })',
};
export default async function ({ checks }, p = {}) {
  return checks.brief.asked(p);
}
