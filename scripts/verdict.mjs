export const meta = {
  purpose:
    "One row per distinct check with its cost, its failures in the CI window, where else the same thing runs, and candidates in the auditors' terms: merge, narrow, shorten (an instruction line), cut-or-narrow (slow and never failed), fix-cause (a format or lint check that keeps failing), keep, or unknown (no timing). Candidates only: read the evidence behind a row before judging it.",
  params: { folder: "optional", ci: "read CI history, default true", runs: "completed runs, default and maximum 30", max: "rows listed, default 30" },
  returns: "{folder, source, checks, candidates:{action: n}, rows[{check, kind, scope, triggers, where[], alsoReachedBy[], ci:{runs, failures, medianS, totalMin, failedOn[]}, candidates[{action, reason}]}], caution}",
  example: 'await scripts.run("verdict", { folder: "/path/to/repo" })',
};
export default async function ({ checks }, p = {}) {
  return checks.brief.verdict(p);
}
