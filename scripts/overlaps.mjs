export const meta = {
  purpose:
    "Checks that run the same command under more than one trigger or place (a hook, a CI step in two workflows, a Claude Code hook, an instruction line), found through package scripts, make targets and shell scripts too; and whole-project runs that sit beside narrower runs of the same tool. Candidates: two places may be a deliberate pair.",
  params: { folder: "optional", user: "include the user's Claude Code hooks, default true", max: "groups listed, default 25" },
  returns: "{folder, sameCommandUnderSeveralPlaces[{command, triggers, places, at[{trigger, where, via}]}], containedInBroaderRun[], counts}",
  example: 'await scripts.run("overlaps", { folder: "/path/to/repo" })',
};
export default async function ({ checks }, p = {}) {
  return checks.brief.overlaps(p);
}
