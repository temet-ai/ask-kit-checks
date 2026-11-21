// Timing reports that already sit on disk: nextest and other JUnit XML, vitest and jest JSON.
// Nothing is run; a repository with none says where it looked.
import fs from "node:fs";
import path from "node:path";

const DIRS = ["target/nextest", "test-results", "reports", "report", "coverage", "junit", "build/test-results", "build/reports", "artifacts", ".reports", "playwright-report", "target/nextest/timing"];
const NAME = /(junit.*\.xml|^TEST-.*\.xml|vitest.*\.json|jest.*\.json|test-?results?.*\.(json|xml)|timing.*\.(json|xml)|nextest.*\.(xml|json))$/i;
const MAX = 60 * 1024 * 1024;

function walk(dir, depth, out, seen) {
  let names; try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of names) {
    const p = path.join(dir, d.name);
    if (d.isDirectory() && depth > 0 && !/^(node_modules|\.git|deps|build|incremental)$/.test(d.name)) walk(p, depth - 1, out, seen);
    else if (d.isFile() && NAME.test(d.name) && !seen.has(p)) { seen.add(p); out.push(p); }
  }
}

export function findReports(root, extra = []) {
  const out = [], seen = new Set(), searched = [];
  for (const d of DIRS) { searched.push(d); walk(path.join(root, d), 3, out, seen); }
  walk(root, 0, out, seen);
  try {
    for (const d of fs.readdirSync(root, { withFileTypes: true })) if (d.isDirectory() && !d.name.startsWith(".") && !/^(node_modules|target)$/.test(d.name)) for (const s of ["test-results", "reports", "coverage"]) { searched.push(`${d.name}/${s}`); walk(path.join(root, d.name, s), 2, out, seen); }
  } catch {}
  for (const e of extra) { const p = path.resolve(root, e); if (!seen.has(p)) { seen.add(p); out.push(p); } }
  return { files: out, searched: [...new Set(searched)] };
}

const attr = (s, k) => { const m = s.match(new RegExp(`\\b${k}="([^"]*)"`)); return m ? m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : null; };

function parseJunit(text) {
  const tests = [];
  const re = /<testcase\b([^>]*?)(\/?)>/g;
  let m, last = null;
  const ends = [];
  while ((m = re.exec(text))) { ends.push({ at: m.index, end: re.lastIndex, attrs: m[1], self: m[2] === "/" }); }
  ends.forEach((t, i) => {
    const body = t.self ? "" : text.slice(t.end, i + 1 < ends.length ? ends[i + 1].at : t.end + 4000).split("</testcase>")[0];
    tests.push({ name: attr(t.attrs, "name") || "?", group: attr(t.attrs, "classname") || attr(t.attrs, "file") || "", s: parseFloat(attr(t.attrs, "time") || "0") || 0, failed: /<(failure|error)\b/.test(body), skipped: /<skipped\b/.test(body) });
  });
  return tests;
}
function parseJs(j) {
  const tests = [];
  for (const f of j.testResults || []) for (const a of f.assertionResults || f.testResults || []) tests.push({ name: a.fullName || a.title || "?", group: path.basename(f.name || f.testFilePath || ""), s: (a.duration || 0) / 1000, failed: a.status === "failed", skipped: a.status === "skipped" || a.status === "pending" });
  if (!tests.length && Array.isArray(j.suites)) { const walkS = (s, g) => { for (const sp of s.specs || []) for (const t of sp.tests || []) tests.push({ name: sp.title, group: g, s: (t.results || []).reduce((a, r) => a + (r.duration || 0), 0) / 1000, failed: (t.results || []).some((r) => r.status === "failed"), skipped: false }); for (const c of s.suites || []) walkS(c, g); }; for (const s of j.suites) walkS(s, s.title || ""); }
  return tests;
}

/** Slowest tests and groups from each report. */
export function readReports(root, { top = 15, extra = [] } = {}) {
  const { files, searched } = findReports(root, extra);
  const reports = [];
  for (const f of files) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (st.size > MAX) { reports.push({ file: path.relative(root, f), skipped: `over ${MAX >> 20} MB` }); continue; }
    let text; try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    let tests = [];
    try { tests = /\.xml$/i.test(f) ? parseJunit(text) : parseJs(JSON.parse(text)); } catch { continue; }
    if (!tests.length) continue;
    const groups = new Map();
    for (const t of tests) { const g = groups.get(t.group) || { group: t.group, tests: 0, s: 0 }; g.tests++; g.s += t.s; groups.set(t.group, g); }
    const total = tests.reduce((a, t) => a + t.s, 0);
    reports.push({
      file: path.relative(root, f), modified: st.mtime.toISOString(), ageDays: Math.round((Date.now() - st.mtimeMs) / 86400000 * 10) / 10,
      tests: tests.length, failed: tests.filter((t) => t.failed).length, skipped: tests.filter((t) => t.skipped).length,
      sumOfTestSeconds: Math.round(total * 10) / 10, note: "the sum of per-test times; the suite's wall time is lower when tests run in parallel",
      slowest: [...tests].sort((a, b) => b.s - a.s).slice(0, top).map((t) => ({ test: (t.group ? t.group + " " : "") + t.name, s: Math.round(t.s * 100) / 100 })),
      slowestGroups: [...groups.values()].sort((a, b) => b.s - a.s).slice(0, 6).map((g) => ({ group: g.group, tests: g.tests, s: Math.round(g.s * 10) / 10 })),
      failedTests: tests.filter((t) => t.failed).slice(0, 10).map((t) => (t.group ? t.group + " " : "") + t.name),
    });
  }
  reports.sort((a, b) => (b.modified || "").localeCompare(a.modified || ""));
  return { reports, searched, found: reports.length };
}
