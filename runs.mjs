// CI history through `gh run list` and `gh run view --json jobs`: how long each job and step took
// and how often it failed, over the last runs (at most 30 per call). Read-only: gh is called with
// a fixed set of read commands and nothing else.
import { execFile } from "node:child_process";

const ALLOWED = [["run", "list"], ["run", "view"], ["workflow", "list"]];
export const MAX_RUNS = 30;

export function makeGh(cwd, timeoutMs = 90_000) {
  return (args) => new Promise((resolve) => {
    if (!ALLOWED.some(([a, b]) => args[0] === a && args[1] === b)) { resolve({ code: 126, out: "", err: `not allowed: gh ${args.slice(0, 2).join(" ")} (this kit only reads CI runs)` }); return; }
    execFile("gh", args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GH_PAGER: "cat" } }, (e, out, err) => {
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: out || "", err: e?.code === "ENOENT" ? "gh is not installed" : (err || e?.message || "") });
    });
  });
}

const pool = async (items, n, fn) => {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
};
export const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pctile = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const secs = (a, b) => { const d = (Date.parse(b) - Date.parse(a)) / 1000; return Number.isFinite(d) && d >= 0 ? Math.round(d) : null; };
export const family = (n) => n.replace(/\s*\([^)]*\)\s*$/, "").replace(/\s+\d+\/\d+$/, "").trim();

/** Fetch up to 30 completed runs with their jobs and steps. */
export async function fetchRuns(gh, { runs = MAX_RUNS, workflow, branch, event } = {}) {
  const limit = Math.min(Math.max(1, Math.floor(runs) || MAX_RUNS), MAX_RUNS);
  const args = ["run", "list", "--limit", String(limit), "--json", "databaseId,workflowName,conclusion,status,event,headBranch,createdAt,startedAt,updatedAt,displayTitle,attempt"];
  if (workflow) args.push("--workflow", workflow);
  if (branch) args.push("--branch", branch);
  if (event) args.push("--event", event);
  const l = await gh(args);
  if (l.code !== 0) return { ok: false, why: `gh run list failed: ${l.err.trim().split("\n")[0].slice(0, 200)}` };
  let list; try { list = JSON.parse(l.out); } catch { return { ok: false, why: "gh run list gave no JSON" }; }
  const done = list.filter((r) => r.status === "completed");
  const errors = [];
  const full = await pool(done, 6, async (r) => {
    const v = await gh(["run", "view", String(r.databaseId), "--json", "jobs"]);
    if (v.code !== 0) { errors.push(`run ${r.databaseId}: ${v.err.trim().split("\n")[0].slice(0, 120)}`); return { ...r, jobs: [] }; }
    try { return { ...r, jobs: JSON.parse(v.out).jobs || [] }; } catch { return { ...r, jobs: [] }; }
  });
  full.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return { ok: true, listed: list.length, completed: done.length, inProgress: list.length - done.length, runs: full, errors, from: full[0]?.createdAt || null, to: full[full.length - 1]?.createdAt || null };
}

/** Per job and per step: runs, failures, durations. */
export function jobStats(data) {
  const jobs = new Map();
  for (const run of data.runs) for (const j of run.jobs) {
    const key = `${run.workflowName} / ${j.name}`;
    let r = jobs.get(key);
    if (!r) jobs.set(key, (r = { workflow: run.workflowName, job: j.name, family: family(j.name), n: 0, ok: 0, fail: 0, cancelled: 0, skipped: 0, secs: [], steps: new Map(), failures: [], failedSteps: new Map() }));
    if (j.conclusion === "skipped") { r.skipped++; continue; }
    if (j.conclusion === "cancelled") { r.cancelled++; continue; }
    if (j.conclusion !== "success" && j.conclusion !== "failure") continue;
    r.n++; if (j.conclusion === "success") r.ok++; else r.fail++;
    const d = secs(j.startedAt, j.completedAt); if (d != null) r.secs.push(d);
    for (const s of j.steps || []) {
      if (/^(Set up job|Complete job|Post )/.test(s.name) || (s.conclusion !== "success" && s.conclusion !== "failure")) continue;
      let st = r.steps.get(s.name); if (!st) r.steps.set(s.name, (st = { secs: [], fail: 0, n: 0 }));
      const sd = secs(s.startedAt, s.completedAt); if (sd != null) st.secs.push(sd);
      st.n++; if (s.conclusion === "failure") st.fail++;
    }
    if (j.conclusion === "failure") {
      const fs = (j.steps || []).filter((s) => s.conclusion === "failure").map((s) => s.name);
      for (const n of fs) r.failedSteps.set(n, (r.failedSteps.get(n) || 0) + 1);
      r.failures.push({ run: run.databaseId, at: run.createdAt, event: run.event, branch: run.headBranch, title: String(run.displayTitle || "").slice(0, 90), steps: fs, seconds: d });
    }
  }
  return jobs;
}

const trend = (a) => {
  if (a.length < 6) return null;
  const h = a.length >> 1, o = median(a.slice(0, h)), n = median(a.slice(a.length - h));
  return o ? `${n >= o ? "+" : ""}${Math.round(((n - o) / o) * 100)}%` : null;
};

/** Rows for output, slowest median first. */
export function jobRows(jobs, { steps = 3 } = {}) {
  return [...jobs.values()].filter((r) => r.n > 0).map((r) => ({
    workflow: r.workflow, job: r.job, runs: r.n, failures: r.fail, cancelled: r.cancelled, skipped: r.skipped,
    medianS: median(r.secs), p90S: pctile(r.secs, 0.9), maxS: r.secs.length ? Math.max(...r.secs) : null,
    totalMin: Math.round((r.secs.reduce((a, b) => a + b, 0) / 60) * 10) / 10, trend: trend(r.secs),
    slowestSteps: [...r.steps.entries()].map(([step, s]) => ({ step, medianS: median(s.secs), runs: s.n, failures: s.fail })).sort((a, b) => (b.medianS ?? 0) - (a.medianS ?? 0)).slice(0, steps),
  })).sort((a, b) => (b.medianS ?? 0) - (a.medianS ?? 0));
}

/** Failing test names and error lines from `gh run view --log-failed`. */
export async function failureDetail(gh, runId) {
  const r = await gh(["run", "view", String(runId), "--log-failed"]);
  if (r.code !== 0) return { run: runId, why: `log not available: ${r.err.trim().split("\n")[0].slice(0, 120)}` };
  const tests = new Set(), errors = [];
  let step = null;
  for (const raw of r.out.split("\n")) {
    const m = raw.match(/^([^\t]*)\t([^\t]*)\t(?:\S+Z )?(.*)$/);
    const line = (m ? m[3] : raw).replace(/(?:\x1b|\^\[)\[[0-9;]*m/g, "");
    let x;
    if ((x = line.match(/\b(?:FAIL|TIMEOUT|SIGABRT|SIGSEGV|LEAK)\s+\[\s*[\d.]+s\]\s+(\S.*?)\s*$/))) tests.add(x[1].replace(/^\(\s*\d+\/\s*\d+\)\s*/, ""));
    else if ((x = line.match(/^test (\S+) \.\.\. FAILED$/))) tests.add(x[1]);
    else if ((x = line.match(/^\s*FAIL\s+(\S.{0,120})$/)) && !/^\s*FAIL\s+\[/.test(line)) tests.add(x[1].trim());
    else if ((x = line.match(/^FAILED (\S+)/))) tests.add(x[1]);
    else if ((x = line.match(/^--- FAIL: (\S+)/))) tests.add(x[1]);
    else if ((x = line.match(/^\s*not ok \d+ - (.+)$/))) tests.add(x[1].trim());
    else if ((x = line.match(/^\s*✖ (.+?)(?: \(\d[\d.]*ms\))?$/))) tests.add(x[1].trim());
    else if ((x = line.match(/^\s*● (.{3,120})$/))) tests.add(x[1].trim());
    if (/##\[error\]/.test(line) || /^error(\[\w+\])?: /.test(line)) {
      if (m && !step && m[2] !== "UNKNOWN STEP") step = m[2];
      const t = line.replace(/^.*##\[error\]/, "").trim().slice(0, 160);
      if (t && errors.length < 4 && !errors.includes(t) && !/^Process completed with exit code/.test(t)) errors.push(t);
    }
  }
  return { run: runId, step, tests: [...tests].slice(0, 12), moreTests: Math.max(0, tests.size - 12), errors, logBytes: r.out.length };
}
