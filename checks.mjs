// What a repository's verification work is, what it costs and what it has caught. Reads the
// repository's files and, when the repository is on GitHub and gh is installed, its recent CI runs
// (at most 30). It never runs a test, a build or a hook, and it changes nothing: acting on a
// finding goes through the `repo` folder source, which the host holds back unless the caller asked
// for a change.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeCtx, definitions, expander, gitHooks, claudeHooks, ciWorkflows, instructionLines } from "./collect.mjs";
import { makeGh, fetchRuns, jobStats, jobRows, failureDetail, median, family, MAX_RUNS } from "./runs.mjs";
import { readReports } from "./reports.mjs";
import { brief } from "./brief.mjs";

const run = (cmd, args, cwd, timeout = 20_000) => new Promise((resolve) => {
  execFile(cmd, args, { cwd, timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (e, out, err) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: out || "", err: err || e?.message || "" }));
});
const cap = (a, n) => ({ rows: a.slice(0, n), more: Math.max(0, a.length - n) });
const stepKind = (n) => (/fmt|format|prettier|rustfmt/i.test(n) ? "format" : /clippy|lint|eslint|deny|audit|semgrep|shellcheck|gitleaks|actionlint/i.test(n) ? "lint" : /type|tsc|svelte-check|cargo check/i.test(n) ? "typecheck" : /test|nextest|e2e|playwright|vitest|jest|pytest|spec/i.test(n) ? "test" : /build|compile|release|package/i.test(n) ? "build" : /checkout|setup|install|cache|toolchain|download|upload|login|restore|set up/i.test(n) ? "setup" : "other");
const firstLine = (s) => String(s).split("\n")[0].trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function jobPattern(job) {
  const n = String(job.name || job.id);
  let re = n.split(/\$\{\{[^}]*\}\}/).map(esc).join(".*");
  if (job.matrix && !/\$\{\{/.test(n)) re += "(?: \\(.*\\))?";
  return new RegExp(`(^|/ )${re}$`);
}

export function make({ settings, push, cwd, act }) {
  const start = settings?.CHECKS_ROOT || cwd || process.cwd();
  const repos = new Map();
  const runsCache = new Map();

  async function at(folder) {
    const dir = path.resolve(folder || start);
    // A folder that holds the file .ask-kit-checks-root is read as a whole repository even when it sits inside
    // another one (the bench fixture does); it has no remote, so no CI history is read for it.
    const marked = fs.existsSync(path.join(dir, ".ask-kit-checks-root"));
    const top = marked ? { code: 0, out: dir } : await run("git", ["rev-parse", "--show-toplevel"], dir);
    if (top.code !== 0) throw new Error(`${dir} is not inside a git repository`);
    const root = top.out.trim();
    if (repos.has(root)) return repos.get(root);
    const git = (args) => run("git", args, root);
    const ctx = makeCtx(root, git);
    const [defs, remoteRes] = await Promise.all([definitions(ctx), marked ? null : git(["remote", "get-url", "origin"])]);
    const expand = expander(ctx, defs);
    const remote = marked ? "" : remoteRes.out.trim().replace(/\/\/[^@/]*@/, "//");
    const r = { root, ctx, defs, expand, remote, gh: makeGh(root), cache: {} };
    repos.set(root, r);
    return r;
  }
  const memo = async (r, k, f) => (r.cache[k] ??= await f());

  const collectAll = (r, o = {}) => memo(r, `all:${!!o.user}`, async () => {
    const [h, c, ci, ins] = await Promise.all([gitHooks(r.ctx, r.expand), claudeHooks(r.ctx, r.expand, { user: o.user !== false }), ciWorkflows(r.ctx, r.expand), instructionLines(r.ctx, r.expand, { user: !!o.userInstructions })]);
    return { h, c, ci, ins };
  });

  async function history(r, o = {}) {
    const k = JSON.stringify([o.runs ?? MAX_RUNS, o.workflow ?? null, o.branch ?? null, o.event ?? null]);
    if (!runsCache.has(`${r.root}|${k}`)) {
      if (!/github\.com[:/]/.test(r.remote)) runsCache.set(`${r.root}|${k}`, { ok: false, why: `the remote is ${r.remote ? r.remote.replace(/^.*[/:@]/, "") : "missing"}, not GitHub: no CI history can be read` });
      else runsCache.set(`${r.root}|${k}`, await fetchRuns(r.gh, o));
      push?.({ kind: "gh", detail: `run list/view ${k}`, ms: 0 });
    }
    const d = runsCache.get(`${r.root}|${k}`);
    if (d.ok && d.completed === 0) { const x = { ok: false, why: "gh found no completed CI runs (the repository has no workflows, or none has run)" }; runsCache.set(`${r.root}|${k}`, x); return x; }
    if (d.ok && !d.jobs) d.jobs = jobStats(d);
    return d;
  }

  // Pool the step (or, failing that, the job) statistics of the CI jobs that a workflow step ran in.
  function ciCost(e, d) {
    if (!d?.ok) return null;
    const wf = [...d.jobs.values()];
    const defJob = e._job; if (!defJob) return null;
    const pat = jobPattern(defJob);
    let rows = wf.filter((j) => j.workflow === e.workflow && pat.test(j.job));
    if (!rows.length) rows = wf.filter((j) => pat.test(j.job));
    if (!rows.length) return { matched: false };
    const want = firstLine(e.step);
    const sec = [], jobSec = [];
    let runs = 0, fails = 0, jobRuns = 0, jobFails = 0; const failedOn = [];
    for (const j of rows) jobRuns += 0;
    for (const j of rows) {
      jobRuns += j.n; jobFails += j.fail; jobSec.push(...j.secs);
      for (const [name, s] of j.steps) if (firstLine(name) === want || firstLine(name).startsWith(want) || want.startsWith(firstLine(name))) { sec.push(...s.secs); runs += s.n; fails += s.fail; }
      for (const f of j.failures) if (f.steps.some((x) => firstLine(x) === want)) failedOn.push(f);
    }
    const always = rows.map((j) => { const st = [...j.steps.entries()].find(([name]) => firstLine(name) === want); return st && st[1].n >= 5 && st[1].fail === st[1].n ? `${j.job} (${st[1].fail} of ${st[1].n})` : null; }).filter(Boolean);
    if (!jobRuns) return { matched: false };
    if (runs) return { matched: true, level: "step", runs, failures: fails, medianS: median(sec), totalS: sec.reduce((a, b) => a + b, 0), jobs: rows.length, failedOn: failedOn.slice(-3), always };
    return { matched: true, level: "job", runs: jobRuns, failures: jobFails, medianS: median(jobSec), totalS: jobSec.reduce((a, b) => a + b, 0), jobs: rows.length, always, note: "the step name did not match a step in the runs; these are the whole job's numbers" };
  }
  const attachJobs = (r, all) => {
    const jobOf = new Map();
    for (const wf of all.ci.workflows) for (const j of wf.jobs) jobOf.set(`${wf.file}:${j.id}`, j);
    for (const e of all.ci.entries) e._job = jobOf.get(`${e.workflowFile}:${e.jobId}`);
  };
  const flat = (all) => [...all.h.entries, ...all.c.entries, ...all.ci.entries, ...all.ins.entries].filter((e) => e.kind !== "build");

  const api = {
    root: start, act: !!act,
    at: async (folder) => (await at(folder)).root,

    async inventory(o = {}) {
      const r = await at(o.folder); const all = await collectAll(r, o);
      const n = o.max ?? 60;
      const ci = all.ci.workflows.map((w) => ({
        workflow: w.name, file: w.file, runsOn: [...new Set(w.jobs.map((j) => j.runsOn).filter(Boolean))].slice(0, 3), triggers: w.triggers,
        jobs: w.jobs.map((j) => ({ job: j.name, id: j.id, uses: j.uses || undefined, needs: j.needs.length ? j.needs : undefined, if: j.if ? String(j.if).slice(0, 80) : undefined, matrix: j.matrix || undefined, steps: j.steps.length,
          checks: j.steps.filter((s) => s.checks.length).map((s) => ({ step: s.name.slice(0, 80), runs: s.checks.slice(0, 3) })) })),
      }));
      const ciChecks = all.ci.entries.length;
      const hooks = all.h.entries.map((e) => ({ hook: e.hook, at: e.where, command: e.command, kind: e.kind, scope: e.scope, narrowedToChangedFiles: e.narrowed }));
      const cl = all.c.entries.map((e) => ({ at: e.where, hookScope: e.hookScope, command: e.command, kind: e.kind, timeout: e.timeout, runs: e.runs }));
      const byFile = {};
      for (const e of all.ins.entries) { const f = e.where.replace(/:\d+$/, ""); byFile[f] = (byFile[f] || 0) + 1; }
      const defsCap = cap(r.defs.defs, n);
      return {
        folder: r.root, remote: r.remote || null,
        counts: { gitHookChecks: hooks.length, claudeHookChecks: cl.length, ciWorkflows: ci.length, ciJobs: ci.reduce((a, w) => a + w.jobs.length, 0), ciCheckSteps: ciChecks, instructionLines: all.ins.entries.length, instructionFiles: all.ins.files, packageScriptsAndMakeTargets: r.defs.defs.length },
        gitHooks: hooks.slice(0, n), claudeHooks: cl.slice(0, n), ci, instructionLinesByFile: Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([file, lines]) => ({ file, lines })),
        definitions: defsCap.rows, definitionsCut: defsCap.more,
        notes: [...all.h.notes, ...all.c.notes, ...all.ci.notes, all.ins.negated ? `${all.ins.negated} instruction lines that name a check only to forbid it were left out` : null].filter(Boolean),
        next: "overlaps for the same command under several triggers; asked-to-run for the instruction lines with paths; timings and catches for CI cost and failures",
      };
    },

    async timings(o = {}) {
      const r = await at(o.folder);
      const d = await history(r, o);
      const local = readReports(r.root, { top: o.top ?? 12, extra: o.reportFiles || [] });
      const out = { folder: r.root, source: { ci: d.ok ? `gh run list + gh run view --json jobs, ${d.completed} completed runs from ${d.from} to ${d.to}${d.inProgress ? `, ${d.inProgress} still running and left out` : ""}` : null, localReports: local.found ? local.reports.map((x) => x.file) : [] } };
      if (!d.ok) out.ci = { unavailable: d.why };
      else {
        const rows = jobRows(d.jobs, { steps: 3 });
        const c = cap(rows, o.jobs ?? 15);
        out.ci = { runs: d.completed, window: { from: d.from, to: d.to }, slowestJobs: c.rows, jobsCut: c.more, totalMinutes: Math.round(rows.reduce((a, x) => a + x.totalMin, 0) * 10) / 10, errors: d.errors.length ? d.errors.slice(0, 3) : undefined };
        const fam = new Map();
        for (const j of d.jobs.values()) if (j.n) { const k = `${j.workflow} / ${j.family}`; const f = fam.get(k) || { family: k, variants: 0, runs: 0, secs: [] }; f.variants++; f.runs += j.n; f.secs.push(...j.secs); fam.set(k, f); }
        out.ci.matrixFamilies = [...fam.values()].filter((f) => f.variants > 1).map((f) => ({ family: f.family, variants: f.variants, runs: f.runs, medianS: median(f.secs), totalMin: Math.round(f.secs.reduce((a, b) => a + b, 0) / 6) / 10 })).sort((a, b) => b.totalMin - a.totalMin).slice(0, 8);
        const wall = new Map();
        for (const run of d.runs) if (run.conclusion === "success" || run.conclusion === "failure") { const s = (Date.parse(run.updatedAt) - Date.parse(run.startedAt)) / 1000; if (s >= 0) { const a = wall.get(run.workflowName) || []; a.push(s); wall.set(run.workflowName, a); } }
        out.ci.workflowWall = [...wall.entries()].map(([workflow, a]) => ({ workflow, runs: a.length, medianS: Math.round(median(a)) })).sort((a, b) => b.medianS - a.medianS).slice(0, 10);
      }
      out.localReports = local.reports.slice(0, o.reports ?? 1);
      out.notFound = [];
      if (!local.found) out.notFound.push(`no test timing report on disk (looked in ${local.searched.slice(0, 8).join(", ")} and the top folder); a runner that writes one: cargo nextest with a junit profile, vitest --reporter=json, jest --json`);
      out.notFound.push("git hooks and Claude Code hooks keep no timing: their cost is unknown unless the hook script writes a log");
      return out;
    },

    async catches(o = {}) {
      const r = await at(o.folder);
      const d = await history(r, o);
      if (!d.ok) return { folder: r.root, unavailable: d.why };
      const rows = [...d.jobs.values()].filter((j) => j.n > 0);
      const failing = rows.filter((j) => j.fail > 0).sort((a, b) => b.fail / b.n - a.fail / a.n || b.fail - a.fail);
      const never = rows.filter((j) => j.fail === 0).sort((a, b) => (median(b.secs) ?? 0) - (median(a.secs) ?? 0));
      const newest = failing.flatMap((j) => j.failures.map((f) => ({ ...f, workflow: j.workflow, job: j.job }))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const wantLogs = Math.min(o.logs ?? 3, 6);
      const seen = new Set(), picked = [];
      for (const f of newest) { if (picked.length >= wantLogs) break; if (seen.has(f.run)) continue; seen.add(f.run); picked.push(f); }
      const details = await Promise.all(picked.map(async (f) => ({ ...(await failureDetail(r.gh, f.run)), workflow: f.workflow, at: f.at })));
      const c1 = cap(failing, o.max ?? 15), c2 = cap(never, o.max ?? 15);
      return {
        folder: r.root, source: `gh run list + gh run view --json jobs over ${d.completed} completed runs from ${d.from} to ${d.to}; failing tests from gh run view --log-failed for the ${details.length} newest failed runs`,
        runsByConclusion: Object.fromEntries(Object.entries(d.runs.reduce((a, x) => ((a[`${x.workflowName}: ${x.conclusion}`] = (a[`${x.workflowName}: ${x.conclusion}`] || 0) + 1), a), {})).sort((a, b) => b[1] - a[1]).slice(0, 14)),
        failingJobs: c1.rows.map((j) => ({ workflow: j.workflow, job: j.job, runs: j.n, failures: j.fail, failRate: Math.round((j.fail / j.n) * 100) + "%", failedSteps: [...j.failedSteps.entries()].map(([step, n]) => ({ step: step.slice(0, 80), kind: stepKind(step), n })).sort((a, b) => b.n - a.n).slice(0, 4), recent: j.failures.slice(-3).map((f) => ({ run: f.run, at: f.at.slice(0, 16), title: f.title, event: f.event })) })),
        failingJobsCut: c1.more,
        failedRunDetail: details,
        neverFailed: c2.rows.map((j) => ({ workflow: j.workflow, job: j.job, runs: j.n, medianS: median(j.secs), totalMin: Math.round(j.secs.reduce((a, b) => a + b, 0) / 6) / 10 })), neverFailedCut: c2.more,
        cancelledOrSkipped: rows.filter((j) => j.cancelled || j.skipped).slice(0, 8).map((j) => `${j.workflow} / ${j.job}: ${j.cancelled} cancelled, ${j.skipped} skipped`),
        caution: `${d.completed} runs is a short window: a job with no failure in it has not been shown to catch nothing. A failure counts as a catch only when it was a product defect, not a formatter, a snapshot, a fixture or a setup step; failedSteps[].kind is a hint from the step's name.`,
      };
    },

    async overlaps(o = {}) {
      const r = await at(o.folder); const all = await collectAll(r, o); attachJobs(r, all);
      const entries = flat(all);
      const byKey = new Map();
      for (const e of entries) for (const k of e.keys) { const l = byKey.get(k) || []; l.push(e); byKey.set(k, l); }
      const groups = [], seen = new Set();
      for (const [k, list] of byKey) {
        const uniq = [...new Map(list.map((e) => [`${e.trigger}|${e.where}`, e])).values()];
        if (uniq.length < 2) continue;
        // One CI step that a matrix runs many times is one place.
        const sig = uniq.map((e) => `${e.trigger}|${e.where}`).sort().join(";");
        if (seen.has(sig)) continue; seen.add(sig);
        const triggers = [...new Set(uniq.map((e) => e.trigger))];
        groups.push({ command: k, triggers, places: uniq.length, scope: uniq[0].scope, kind: uniq[0].kind, at: uniq.slice(0, 8).map((e) => ({ trigger: e.trigger, where: e.where, via: e.key !== k ? e.command : undefined })), atCut: Math.max(0, uniq.length - 8) });
      }
      groups.sort((a, b) => b.triggers.length - a.triggers.length || b.places - a.places);
      // A command with no package or path narrowing that runs beside narrower ones of the same tool.
      const fams = new Map();
      for (const e of entries) if (e.kind === "test" || e.kind === "lint" || e.kind === "typecheck") { const l = fams.get(e.runner) || []; l.push(e); fams.set(e.runner, l); }
      const contained = [];
      for (const [runner, list] of fams) {
        const broad = list.filter((e) => e.scope === "all"), narrow = list.filter((e) => e.scope === "narrow");
        if (!broad.length || !narrow.length) continue;
        const b = broad[0];
        const ns = narrow.filter((n) => n.key !== b.key && `${n.trigger}|${n.where}` !== `${b.trigger}|${b.where}`);
        if (ns.length) contained.push({ runner, broad: { command: b.command, trigger: b.trigger, where: b.where }, narrower: ns.slice(0, 4).map((n) => ({ command: n.command, trigger: n.trigger, where: n.where })), note: "the broad command runs everything; a narrower run of the same tool elsewhere may add nothing, or may be a deliberate quick tier. Read both." });
      }
      const c = cap(groups, o.max ?? 25);
      return { folder: r.root, sameCommandUnderSeveralPlaces: c.rows, cut: c.more, containedInBroaderRun: contained.slice(0, 10), counts: { checksSeen: entries.length, commandsInSeveralPlaces: groups.length, underDifferentTriggerKinds: groups.filter((g) => g.triggers.length > 1).length }, caution: "two places running the same command may be a deliberate pair (a quick local check and the full CI one); the verdict is the investigator's" };
    },

    async asked(o = {}) {
      const r = await at(o.folder); const all = await collectAll(r, { ...o, userInstructions: o.user }); attachJobs(r, all);
      const others = new Map();
      for (const e of [...all.h.entries, ...all.c.entries, ...all.ci.entries]) for (const k of e.keys) { const l = others.get(k) || new Set(); l.add(`${e.trigger}: ${e.where}`); others.set(k, l); }
      const d = o.cost === false ? null : await history(r, o);
      const costOf = new Map();
      if (d?.ok) for (const e of all.ci.entries) { const c = ciCost(e, d); if (c?.matched && c.medianS != null && c.level === "step") { const p = costOf.get(e.key); if (!p || c.medianS > p.medianS) costOf.set(e.key, { medianS: c.medianS, runs: c.runs, from: `${e.workflowFile}:${e.jobId}` }); } }
      const groups = new Map();
      for (const e of all.ins.entries) {
        const g = groups.get(e.key) || { command: e.command, kind: e.kind, scope: e.scope, heavy: e.scope === "all" && ["test", "lint", "typecheck"].includes(e.kind) && /^(cargo|npm|pnpm|yarn|bun|make|gmake|pytest|go|deno|vitest|jest|tox|nox|mvn|gradle|gradlew|dotnet|bundle|npx)\b/.test(e.runner), repeated: false, at: [], also: new Set(), cost: null };
        g.at.push({ at: e.where, line: e.text, fileScope: e.fileScope, repeated: e.repeated || undefined }); g.repeated ||= e.repeated;
        for (const k of e.keys) for (const x of others.get(k) || []) g.also.add(x);
        const cst = e.keys.map((k) => costOf.get(k)).find(Boolean); if (cst) g.cost = cst;
        groups.set(e.key, g);
      }
      let rows = [...groups.values()].map((g) => ({ ...g, heavy: g.heavy || (g.scope === "all" && g.cost?.medianS >= 60) })).map((g) => ({ command: g.command, kind: g.kind, scope: g.scope, heavy: g.heavy, repeated: g.repeated, lines: g.at.length, at: g.at.slice(0, 5), atCut: Math.max(0, g.at.length - 5), alsoRunBy: [...g.also].slice(0, 4), alsoRunByCut: Math.max(0, g.also.size - 4), ciMedianS: g.cost?.medianS ?? null, costFrom: g.cost ? `CI step in ${g.cost.from}, median of ${g.cost.runs} runs` : null }));
      rows.sort((a, b) => (b.heavy - a.heavy) || (b.repeated - a.repeated) || (b.lines - a.lines) || ((b.ciMedianS ?? 0) - (a.ciMedianS ?? 0)));
      const c = cap(rows, o.max ?? 30);
      return { folder: r.root, filesRead: all.ins.files, linesWithACheck: all.ins.entries.length, distinctCommands: rows.length, heavyAndRepeated: rows.filter((x) => x.heavy && x.repeated).length, alsoRunElsewhere: rows.filter((x) => x.alsoRunBy.length).length, commands: c.rows, cut: c.more, notes: [all.ins.negated ? `${all.ins.negated} lines that name a check only to forbid it ("never run ...") are left out` : null, d && !d.ok ? `cost not given: ${d.why}` : d ? undefined : "cost not looked up (cost: false)", "heavy: a test, lint or type-check run that covers the whole project (no package, test or path named), or a script whose CI step takes 60 s or more"].filter(Boolean) };
    },

    async verdict(o = {}) {
      const r = await at(o.folder); const all = await collectAll(r, o); attachJobs(r, all);
      const d = o.ci === false ? null : await history(r, o);
      const entries = flat(all);
      const units = new Map();
      for (const e of entries) { const u = units.get(e.key) || { key: e.key, kind: e.kind, scope: e.scope, entries: [], keys: new Set() }; u.entries.push(e); e.keys.forEach((k) => u.keys.add(k)); units.set(e.key, u); }
      // A command that another entry runs by expansion (make check runs cargo clippy): link them.
      const rows = [];
      for (const u of units.values()) {
        const places = [...new Map(u.entries.map((e) => [`${e.trigger}|${e.where}`, e])).values()];
        const triggers = [...new Set(places.map((e) => e.trigger))];
        const viaOthers = entries.filter((e) => e.key !== u.key && e.keys.includes(u.key) && !places.some((p) => p.where === e.where));
        const ciE = places.filter((e) => e.trigger === "ci");
        let ci = null;
        if (d?.ok && ciE.length) {
          const cs = ciE.map((e) => ciCost(e, d)).filter((c) => c?.matched);
          if (cs.length) ci = { level: cs[0].level, runs: Math.max(...cs.map((c) => c.runs)), failures: cs.reduce((a, c) => a + c.failures, 0), medianS: cs.reduce((a, c) => a + (c.medianS ?? 0), 0), totalMin: Math.round(cs.reduce((a, c) => a + c.totalS, 0) / 6) / 10, failedOn: cs.flatMap((c) => c.failedOn || []).slice(-2).map((f) => ({ run: f.run, at: f.at.slice(0, 10), title: f.title })), alwaysFailing: cs.flatMap((c) => c.always || []).slice(0, 4), note: cs[0].note };
        }
        const cands = [];
        const hooksAll = places.filter((e) => (e.trigger === "git-hook" || e.trigger === "claude-hook") && e.scope === "all" && e.narrowed !== true && ["test", "lint", "typecheck", "format"].includes(e.kind));
        const inst = places.filter((e) => e.trigger === "instruction");
        const runners = places.filter((e) => e.trigger !== "instruction");
        if (runners.length >= 2 || (runners.length >= 1 && viaOthers.some((e) => e.trigger !== "instruction")))
          cands.push({ action: "merge", reason: `the same command runs in ${runners.length + viaOthers.filter((e) => e.trigger !== "instruction").length} places (${[...new Set([...runners, ...viaOthers.filter((e) => e.trigger !== "instruction")].map((e) => e.trigger))].join(", ")}); keep the one that runs first or cheapest and show it still covers the case before removing the others` });
        if (hooksAll.length) cands.push({ action: "narrow", reason: `a ${hooksAll[0].trigger === "git-hook" ? "git hook" : "Claude Code hook"} runs it over the whole project; narrow it to the changed files, or to one representative case` });
        if (inst.length && (runners.length || viaOthers.length)) cands.push({ action: "shorten", reason: `${inst.length} instruction line${inst.length > 1 ? "s tell" : " tells"} a session to run what ${runners.length ? "a hook or CI already runs" : "another check runs"}; delete or shorten ${inst.slice(0, 3).map((e) => e.where).join(", ")}` });
        else if (inst.length && u.scope === "all" && inst.some((e) => e.repeated)) cands.push({ action: "shorten", reason: `an instruction asks for a whole-project run repeatedly (${inst.filter((e) => e.repeated).slice(0, 2).map((e) => e.where).join(", ")}); ask for it once, before handing over` });
        if (ci?.alwaysFailing?.length) cands.push({ action: "fix-cause", reason: `fails on every run in these jobs: ${ci.alwaysFailing.join(", ")}; a check that always fails is either broken (fix it) or ignored (then it costs the minutes and catches nothing new)` });
        if (ci && ci.level === "step") {
          if (ci.runs >= 10 && ci.failures === 0 && ci.medianS >= 60) cands.push({ action: "cut-or-narrow", reason: `ran ${ci.runs} times, never failed, median ${Math.round(ci.medianS)}s (${ci.totalMin} min in the window); ${ci.runs} runs is a short window, and a product defect found only here would justify it` });
          else if (ci.failures > 0 && ci.failures / ci.runs >= 0.3 && ["format", "lint"].includes(u.kind)) cands.push({ action: "fix-cause", reason: `failed ${ci.failures} of ${ci.runs} runs and it is a ${u.kind} check: failures like this are maintenance; fix what produces them` });
          else if (ci.runs < 10) cands.push({ action: "keep", reason: `only ${ci.runs} runs in the window: too few to judge` });
        } else if (!ci && !ciE.length && !runners.length && !viaOthers.length) cands.push({ action: "keep", reason: "only an instruction asks for it; no hook or CI step runs it, so there is no timing here. How often sessions ran it and how long they waited is in session history (mike)" });
        else if (!ci && !ciE.length) cands.push({ action: "unknown", reason: "no CI timing: " + (runners.some((e) => e.trigger === "git-hook" || e.trigger === "claude-hook") ? "hooks keep no timing log" : "it is not a CI step") });
        else if (ciE.length && !ci) cands.push({ action: "unknown", reason: d?.ok ? "its CI job did not appear in the runs fetched (it may run only on a schedule, a tag or a path filter)" : `no CI history: ${d?.why || "not asked for"}` });
        if (cands.length > 1) { const i = cands.findIndex((c) => c.action === "keep"); if (i >= 0) cands.splice(i, 1); }
        if (!cands.length) cands.push({ action: "keep", reason: ci?.failures ? `failed ${ci.failures} of ${ci.runs} runs; read what failed before judging` : "no overlap, not slow, or too little evidence" });
        rows.push({ check: u.key.slice(0, 140), kind: u.kind, scope: u.scope, triggers, places: places.length, where: places.slice(0, 4).map((e) => `${e.trigger}: ${e.where}`), alsoReachedBy: viaOthers.slice(0, 3).map((e) => `${e.trigger}: ${e.where} (${e.command.slice(0, 50)})`), ci: ci || undefined, candidates: cands, _w: (ci?.totalMin ?? 0) + (cands[0].action === "merge" ? 1000 : 0) + (cands[0].action === "cut-or-narrow" ? 500 : 0) + (cands[0].action === "shorten" ? 200 : 0) });
      }
      // CI jobs that ran but are defined in no workflow file here (GitHub's default CodeQL setup, a required workflow from the organisation).
      if (d?.ok) {
        const pats = all.ci.workflows.flatMap((w) => w.jobs.map((j) => jobPattern(j)));
        for (const j of d.jobs.values()) {
          if (!j.n || pats.some((p) => p.test(j.job))) continue;
          const tot = Math.round(j.secs.reduce((a, b) => a + b, 0) / 6) / 10, med = median(j.secs);
          const cands = [];
          if (j.n >= 10 && j.fail === 0 && med >= 60) cands.push({ action: "cut-or-narrow", reason: `ran ${j.n} times, never failed, median ${Math.round(med)}s (${tot} min in the window); no workflow file in the repository defines it, so it is switched off in the repository's settings (or by the organisation), not by editing a file` });
          else if (j.fail === j.n && j.n >= 5) cands.push({ action: "fix-cause", reason: `failed on all ${j.n} runs` });
          else cands.push({ action: "keep", reason: j.fail ? `failed ${j.fail} of ${j.n} runs; read what failed before judging` : `${j.n} runs, none failed, median ${Math.round(med)}s: too little to judge` });
          rows.push({ check: `${j.workflow} / ${j.job}`, kind: "audit", scope: "all", triggers: ["ci"], places: 1, where: ["ci: not defined in the repository's files"], alsoReachedBy: [], ci: { level: "job", runs: j.n, failures: j.fail, medianS: med, totalMin: tot, failedOn: [] }, candidates: cands, _w: tot + (cands[0].action === "cut-or-narrow" ? 500 : 0) });
        }
      }
      rows.sort((a, b) => b._w - a._w); rows.forEach((x) => delete x._w);
      const c = cap(rows, o.max ?? 30);
      return { folder: r.root, source: d?.ok ? `files in the repository, and ${d.completed} CI runs from ${d.from} to ${d.to}` : `files in the repository only${d && !d.ok ? ` (${d.why})` : ""}`, checks: rows.length, candidates: Object.fromEntries(Object.entries(rows.reduce((a, x) => ((a[x.candidates[0].action] = (a[x.candidates[0].action] || 0) + 1), a), {}))), rows: c.rows, cut: c.more, caution: "candidates only. Never recommend adding a check or a rule. A cut needs the evidence that something else still covers the case." };
    },
  };
  // Drop keys whose value is undefined, so optional fields are absent rather than null.
  const tidy = (v) => (Array.isArray(v) ? v.map(tidy) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, tidy(x)])) : v);
  for (const k of ["inventory", "timings", "catches", "overlaps", "asked", "verdict"]) { const f = api[k]; api[k] = async (...a) => tidy(await f(...a)); }
  // Compact forms, one string per row and under the host's 4000-character clip: what the scripts return.
  api.brief = Object.fromEntries(Object.keys(brief).map((k) => [k, async (...a) => brief[k](await api[k](...a))]));
  return api;
}
