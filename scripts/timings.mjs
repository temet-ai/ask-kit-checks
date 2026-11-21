export const meta = {
  purpose:
    "How long checks take: CI time per job and per step over the last runs (median, p90, max, trend, the slowest steps), matrix jobs pooled, the median wall time of each workflow, and the slowest tests from any timing report already on disk (nextest JUnit, vitest or jest JSON). Reads gh run history only: at most 30 runs, no suite is run. Says where each number came from and what it could not find.",
  params: { folder: "optional", runs: "completed runs to read, default and maximum 30", workflow: "only this workflow (name or file)", branch: "only this branch", event: "only this event (push, pull_request, schedule)", jobs: "jobs listed, default 15", top: "slowest tests per report, default 12" },
  returns: "{folder, source, ci:{runs, window, slowestJobs[{workflow, job, runs, failures, medianS, p90S, maxS, totalMin, trend, slowestSteps[]}], matrixFamilies[], workflowWall[]} | {unavailable}, localReports[], notFound[]}",
  example: 'await scripts.run("timings", { folder: "/path/to/repo", runs: 30 })',
};
export default async function ({ checks }, p = {}) {
  return checks.brief.timings(p);
}
