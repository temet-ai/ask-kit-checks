// Compact forms of the results: one short string per row, and a size limit, because the host clips
// a value the investigator sees at 4000 characters.
export const LIMIT = 3700;
const s = (v, n = 120) => { v = String(v ?? ""); return v.length > n ? v.slice(0, n - 1) + "…" : v; };
const sec = (n) => (n == null ? "?" : n >= 120 ? `${(n / 60).toFixed(1)}m` : `${Math.round(n)}s`);
const tail = (v, n = 70) => { v = String(v ?? ""); return v.length > n ? "…" + v.slice(-(n - 1)) : v; };
const home = (p) => String(p).replace(/^\/home\/[^/]+/, "~");

/** Shorten arrays (longest first) until the JSON fits; each cut array ends with a "+N more" entry. */
export function fit(obj, limit = LIMIT) {
  const size = (v) => JSON.stringify(v, null, 1).length;
  const cuts = new Map();
  let guard = 400;
  while (size(obj) > limit && guard-- > 0) {
    let best = null;
    const walk = (v) => {
      if (Array.isArray(v)) {
        const n = v.length - (cuts.get(v) ? 1 : 0);
        if (n > 1) { const w = JSON.stringify(v).length; if (!best || w > best.w) best = { v, w }; }
        v.forEach(walk);
      } else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(obj);
    if (!best) break;
    const a = best.v, had = cuts.get(a) || 0;
    if (had) a.pop();
    a.pop();
    cuts.set(a, had + 1);
    a.push(`+${had + 1 + (a.__base || 0)} more cut`);
  }
  return obj;
}
// The "+N more" count must include rows the module already cut; keep it simple: say how many this step removed.

export const brief = {
  inventory(r) {
    const trig = (e) => `${e.hook ? e.hook + " " : ""}${e.at}: ${s(e.command, 70)} [${e.kind}${e.narrowedToChangedFiles ? ", changed files" : ""}]`;
    return fit({
      folder: r.folder, remote: r.remote, counts: r.counts,
      gitHooks: r.gitHooks.map(trig),
      claudeHooks: r.claudeHooks.map((e) => `${e.at}: ${s(e.command, 80)} [${e.kind}]`),
      ci: r.ci.map((w) => `${w.file} on ${s(w.triggers, 90)}: ${w.jobs.map((j) => `${s(j.job, 28)}${j.matrix ? " x" + Object.values(j.matrix).reduce((a, b) => a * (Number(b) || 1), 1) : ""}${j.checks.length ? " (" + j.checks.map((c) => s(c.runs[0], 28)).join("; ") + ")" : ""}`).join(", ")}`).map((x) => s(x, 330)),
      instructionLinesByFile: r.instructionLinesByFile.slice(0, 8).map((f) => `${f.file} ${f.lines}`),
      definitions: r.definitions.slice(0, 8).map((d) => `${d.where} = ${s(d.command, 70)}`),
      notes: r.notes.filter(Boolean).map((x) => s(x, 160)),
      more: "checks.inventory() has every row; overlaps, asked-to-run, timings and catches say more",
    });
  },
  timings(r) {
    const out = { folder: r.folder, source: r.source };
    if (r.ci.unavailable) out.ci = r.ci.unavailable;
    else {
      out.window = `${r.ci.runs} completed runs, ${r.ci.window.from?.slice(0, 10)} to ${r.ci.window.to?.slice(0, 10)}; ${r.ci.totalMinutes} job-minutes in all`;
      out.slowestJobs = r.ci.slowestJobs.slice(0, 9).map((j) => `${s(j.workflow, 22)} / ${s(j.job, 34)}: median ${sec(j.medianS)} p90 ${sec(j.p90S)} max ${sec(j.maxS)}, ${j.runs} runs, ${j.failures} failed, ${j.totalMin} min${j.trend ? ", trend " + s(j.trend, 12) : ""}; steps: ${j.slowestSteps.slice(0, 2).map((x) => `${s(x.step, 36)} ${sec(x.medianS)}`).join(", ")}`);
      out.matrixFamilies = r.ci.matrixFamilies.slice(0, 3).map((f) => `${f.family}: ${f.variants} variants, median ${sec(f.medianS)}, ${f.totalMin} min`);
      out.workflowWall = r.ci.workflowWall.slice(0, 5).map((w) => `${s(w.workflow, 28)} median ${sec(w.medianS)} (${w.runs} runs)`);
    }
    if (r.localReports.length) out.localReports = r.localReports.slice(0, 2).map((x) => ({ file: x.file, ageDays: x.ageDays, tests: x.tests, failed: x.failed, sumOfTestSeconds: x.sumOfTestSeconds, slowest: x.slowest.slice(0, 8).map((t) => `${s(t.test, 70)} ${t.s}s`), slowestGroups: x.slowestGroups.slice(0, 3).map((g) => `${s(g.group, 40)} ${g.tests} tests ${g.s}s`) }));
    out.notFound = r.notFound.map((x) => s(x, 200));
    return fit(out);
  },
  catches(r) {
    if (r.unavailable) return r;
    return fit({
      folder: r.folder, source: s(r.source, 230),
      runs: Object.entries(r.runsByConclusion).slice(0, 8).map(([k, v]) => `${s(k, 40)} ${v}`),
      failingJobs: r.failingJobs.slice(0, 7).map((j) => `${s(j.workflow, 22)} / ${s(j.job, 34)}: ${j.failures} of ${j.runs} failed (${j.failRate}); on ${j.failedSteps.slice(0, 2).map((x) => `${s(x.step, 36)} [${x.kind}] x${x.n}`).join(", ") || "?"}; last ${j.recent.slice(-1).map((x) => `${x.at.slice(0, 10)} run ${x.run}`)}`),
      failedRunDetail: r.failedRunDetail.map((d) => d.why ? `run ${d.run}: ${d.why}` : `run ${d.run} (${s(d.workflow, 24)}, ${d.at?.slice(0, 10)}): ${d.tests?.length ? "tests: " + d.tests.slice(0, 4).map((t) => tail(t, 70)).join("; ") + (d.tests.length > 4 || d.moreTests ? " …" : "") : "no test names"}${d.errors?.length ? " | " + s(d.errors[0], 110) : ""}`),
      neverFailed: r.neverFailed.slice(0, 8).map((j) => `${s(j.workflow, 22)} / ${s(j.job, 34)}: ${j.runs} runs, median ${sec(j.medianS)}, ${j.totalMin} min`),
      neverFailedCount: r.neverFailed.length + r.neverFailedCut,
      caution: r.caution,
    });
  },
  overlaps(r) {
    return fit({
      folder: r.folder, counts: r.counts,
      sameCommand: r.sameCommandUnderSeveralPlaces.slice(0, 10).map((g) => `${s(g.command, 80)} x${g.places} [${g.triggers.join("+")}]: ${g.at.slice(0, 4).map((a) => `${a.trigger} ${s(a.where, 60)}${a.via ? " via " + s(a.via, 30) : ""}`).join("; ")}${g.places > 4 ? " …" : ""}`),
      containedInBroaderRun: r.containedInBroaderRun.slice(0, 4).map((c) => `${c.runner}: broad \`${s(c.broad.command, 60)}\` (${s(c.broad.where, 50)}) beside ${c.narrower.slice(0, 2).map((n) => `\`${s(n.command, 50)}\` (${s(n.where, 40)})`).join(", ")}`),
      caution: r.caution,
    });
  },
  asked(r) {
    return fit({
      folder: r.folder, filesRead: r.filesRead, linesWithACheck: r.linesWithACheck, distinctCommands: r.distinctCommands, heavyAndRepeated: r.heavyAndRepeated, alsoRunElsewhere: r.alsoRunElsewhere,
      commands: r.commands.slice(0, 12).map((c) => `${c.heavy ? "heavy " : ""}${c.repeated ? "repeated " : ""}\`${s(c.command, 70)}\` ${c.lines}x: ${c.at.slice(0, 3).map((a) => s(a.at, 50)).join(", ")}${c.lines > 3 ? " …" : ""}${c.alsoRunBy.length ? ` | also ${c.alsoRunBy.slice(0, 2).map((x) => s(x, 50)).join("; ")}` : ""}${c.ciMedianS != null ? ` | CI ${sec(c.ciMedianS)}` : ""}`),
      notes: r.notes.map((x) => s(x, 160)),
    });
  },
  verdict(r) {
    return fit({
      folder: r.folder, source: s(r.source, 160), checks: r.checks, candidates: r.candidates,
      rows: r.rows.slice(0, 10).map((x) => `${x.candidates.map((c) => c.action).join("+")} | \`${s(x.check, 60)}\` [${x.kind}] ${x.where.slice(0, 2).map((w) => s(w, 75)).join("; ")}${x.places > 2 ? ` +${x.places - 2}` : ""}${x.ci ? ` | CI ${x.ci.runs} runs, ${x.ci.failures} failed, median ${sec(x.ci.medianS)}, ${x.ci.totalMin} min${x.ci.level === "job" ? " (whole job)" : ""}` : ""} | ${s(x.candidates[0].reason, 150)}`),
      caution: r.caution,
    });
  },
};
