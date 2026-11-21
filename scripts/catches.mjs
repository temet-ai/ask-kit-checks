export const meta = {
  purpose:
    "How often each CI job failed over the last runs and on which step; for the newest failed runs, the failing test names and error lines from the log; and the jobs that did not fail once in the window, slowest first. A failure is not yet a catch: the step's kind (format, lint, test, setup) is a hint for telling a product defect from maintenance.",
  params: { folder: "optional", runs: "completed runs to read, default and maximum 30", workflow: "only this workflow", branch: "only this branch", logs: "failed runs whose logs are read, default 3, at most 6", max: "rows per list, default 15" },
  returns: "{folder, source, runsByConclusion, failingJobs[{workflow, job, runs, failures, failRate, failedSteps[{step, kind, n}], recent[]}], failedRunDetail[{run, tests[], errors[]}], neverFailed[{workflow, job, runs, medianS, totalMin}], caution} | {unavailable}",
  example: 'await scripts.run("catches", { folder: "/path/to/repo", logs: 2 })',
};
export default async function ({ checks }, p = {}) {
  return checks.brief.catches(p);
}
