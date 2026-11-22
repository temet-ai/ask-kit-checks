// Finds where a repository defines and triggers its checks: git hooks, Claude Code hooks, CI
// workflows, package scripts, Makefile targets, and the instruction lines that tell a session to
// run something. Reads files only; runs nothing but `git config` and `git ls-files`.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseYaml } from "./yaml.mjs";
import { commandsOf, classify, normal, scopeOf, tokens, NEGATED, REPEATED } from "./commands.mjs";

const GIT_HOOKS = new Set(["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge", "pre-push", "pre-merge-commit", "post-rewrite", "pre-auto-gc", "applypatch-msg", "pre-applypatch", "post-applypatch", "update", "push-to-checkout", "reference-transaction"]);
const MAX_FILE = 300_000;
const short = (s, n = 160) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function makeCtx(root, git) {
  let tracked = null;
  const rd = (rel) => {
    try {
      const p = path.isAbsolute(rel) ? rel : path.join(root, rel);
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > MAX_FILE) return null;
      return fs.readFileSync(p, "utf8");
    } catch { return null; }
  };
  return {
    root, git, rd,
    async files() {
      if (tracked) return tracked;
      const r = await git(["ls-files", "-co", "--exclude-standard", "-z"]);
      tracked = r.code === 0 ? r.out.split("\0").filter(Boolean) : [];
      return tracked;
    },
  };
}

/** package.json scripts and Makefile / justfile targets: what `npm test` or `make test` runs. */
export async function definitions(ctx) {
  const files = await ctx.files();
  const pkg = new Map(), make = new Map(), defs = [];
  for (const f of files) {
    if (!/(^|\/)package\.json$/.test(f) || /node_modules/.test(f)) continue;
    let j; try { j = JSON.parse(ctx.rd(f) || "null"); } catch { j = null; }
    if (!j?.scripts) continue;
    const dir = path.dirname(f) === "." ? "" : path.dirname(f);
    for (const [name, body] of Object.entries(j.scripts)) {
      if (typeof body !== "string") continue;
      pkg.set(`${dir}::${name}`, body);
      const cmds = commandsOf(body).map((c) => ({ c, cls: classify(c) })).filter((x) => x.cls);
      if (cmds.length || /^(test|lint|check|typecheck|format|fmt|e2e|verify)/.test(name)) defs.push({ trigger: "definition", where: `${f}:${name}`, name, command: short(body, 200), kinds: [...new Set(cmds.map((x) => x.cls.kind))] });
    }
  }
  for (const f of files) {
    if (!/(^|\/)(Makefile|makefile|GNUmakefile)$/.test(f) || f.split("/").length > 2) continue;
    const text = ctx.rd(f); if (!text) continue;
    const lines = text.replace(/\\\n\s*/g, " ").split("\n");
    let cur = null;
    lines.forEach((l, i) => {
      const m = l.match(/^([A-Za-z0-9_.\-\/%]+(?:\s+[A-Za-z0-9_.\-\/%]+)*)\s*:(?!=)\s*([^#]*?)\s*(?:#.*)?$/);
      if (m && !l.startsWith("\t") && !l.startsWith(".PHONY") && !m[1].includes("=")) {
        const deps = m[2].split("|")[0].split(/\s+/).filter(Boolean);
        cur = { names: m[1].split(/\s+/), deps, recipe: [], line: i + 1, file: f };
        for (const n of cur.names) make.set(n, cur);
      } else if (cur && l.startsWith("\t")) {
        cur.recipe.push(...commandsOf(l.trim().replace(/^[@\-+]+/, "").replace(/\$\(MAKE\)/g, "make")));
      } else if (l.trim() && !l.startsWith("#") && !l.startsWith("\t")) cur = null;
    });
    for (const [name, t] of make) {
      if (t.file !== f || t.names[0] !== name) continue;
      const cmds = t.recipe.map((c) => classify(c)).filter(Boolean);
      if (cmds.length || /^(test|lint|check|fmt|gate|ci|verify)/.test(name)) defs.push({ trigger: "definition", where: `${f}:${t.line}`, name: `make ${name}`, command: short([...t.deps.map((d) => `[${d}]`), ...t.recipe].join(" ; "), 200), kinds: [...new Set(cmds.map((x) => x.kind))] });
    }
  }
  return { pkg, make, defs };
}

/** The check commands a command stands for: what a package script, make target or script file runs. */
export function expander(ctx, defs) {
  const cache = new Map();
  const seenFiles = new Map();
  const expand = (cmd, depth = 0, seen = new Set()) => {
    const key = normal(cmd) + "@" + depth;
    if (cache.has(key)) return cache.get(key);
    const out = [];
    cache.set(key, out);
    if (depth > 2) return out;
    const self = normal(cmd);
    if (seen.has(self)) return out;
    seen = new Set(seen).add(self);
    const t = tokens(cmd);
    const a = t[0];
    const add = (c) => { const cls = classify(c); const n = normal(c); if (cls && cls.kind !== "build" && n !== self && !out.includes(n)) out.push(n); for (const x of expand(c, depth + 1, seen)) if (!out.includes(x)) out.push(x); };
    if (/^(npm|pnpm|yarn|bun)$/.test(a)) {
      let dir = "";
      const rest = [];
      for (let i = 1; i < t.length; i++) {
        if (/^(--prefix|-C|--dir|--cwd)$/.test(t[i])) { dir = (t[++i] || "").replace(/^\.\//, "").replace(/\/$/, ""); continue; }
        const m = t[i].match(/^--(prefix|dir|cwd)=(.*)$/); if (m) { dir = m[2].replace(/^\.\//, ""); continue; }
        if (/^(--filter|-F|-w|--workspace)$/.test(t[i])) { i++; continue; }
        if (!t[i].startsWith("-")) rest.push(t[i]);
      }
      const s = rest[0] === "run" || rest[0] === "run-script" ? rest[1] : rest[0];
      const body = s ? defs.pkg.get(`${dir}::${s}`) : null;
      if (body) for (const c of commandsOf(body)) add(c);
    } else if (a === "make" || a === "gmake") {
      const target = t.slice(1).find((x) => !x.startsWith("-") && !x.includes("="));
      const walk = (name, d) => { const tg = defs.make.get(name); if (!tg || d > 3) return; for (const dep of tg.deps) walk(dep, d + 1); for (const c of tg.recipe) add(c); };
      if (target) walk(target, 0);
    } else {
      const f = /^(bash|sh)$/.test(a) ? t.find((x, i) => i > 0 && !x.startsWith("-")) : a;
      if (f && (f.includes("/") || f.startsWith("./"))) {
        let text = seenFiles.get(f);
        if (text === undefined) { text = ctx.rd(f.replace(/^\.\//, "")); seenFiles.set(f, text); }
        if (text && (/^#!.*\b(ba|z)?sh\b/.test(text) || /\.sh$/.test(f))) for (const c of commandsOf(text.replace(/^#!.*\n/, "").replace(/^\s*#.*$/gm, ""))) add(c);
      }
    }
    return out;
  };
  return expand;
}

const entry = (ctx, expand, trigger, where, command, extra = {}) => {
  const cls = classify(command);
  if (!cls) return null;
  // A command that runs in a subfolder (a step's working-directory, a nested AGENTS.md) is a different check from the same text at the root.
  const wd = (extra.workingDirectory || extra.dir || "").replace(/^\.\//, "").replace(/\/$/, "");
  const pre = wd && wd !== "." ? `[${wd}] ` : "";
  const key = pre + normal(command);
  return { trigger, where, command: short(command, 220), key, keys: [key, ...(pre ? [] : expand(command))].filter((v, i, a) => a.indexOf(v) === i), kind: cls.kind, runner: cls.runner, scope: scopeOf(command), ...extra };
};

/** Git hooks: core.hooksPath, .git/hooks, .husky, .githooks, lefthook, pre-commit. */
export async function gitHooks(ctx, expand) {
  const entries = [], notes = [], seen = new Set();
  const [hp, gp] = await Promise.all([ctx.git(["config", "--get", "core.hooksPath"]), ctx.git(["rev-parse", "--git-path", "hooks"])]);
  const dirs = [];
  if (hp.code === 0 && hp.out.trim()) { const d = path.resolve(ctx.root, hp.out.trim().replace(/^~/, os.homedir())); dirs.push([d, "core.hooksPath"]); notes.push(`core.hooksPath = ${hp.out.trim()}`); }
  if (gp.code === 0) dirs.push([path.resolve(ctx.root, gp.out.trim()), ".git/hooks"]);
  for (const d of [".husky", ".githooks"]) if (fs.existsSync(path.join(ctx.root, d))) dirs.push([path.join(ctx.root, d), d]);
  for (const [dir, label] of dirs) {
    if (seen.has(dir)) continue; seen.add(dir);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { notes.push(`${label}: folder ${path.relative(ctx.root, dir) || dir} does not exist`); continue; }
    const real = names.filter((n) => !n.endsWith(".sample") && !n.startsWith("_") && !n.startsWith(".") && fs.statSync(path.join(dir, n)).isFile());
    if (!real.length) { const rel = path.relative(ctx.root, dir) || dir; notes.push(`${rel}${rel === label ? "" : ` (${label})`} holds no hook: ${names.length} files, all samples`); };
    for (const n of real) {
      const rel = path.relative(ctx.root, path.join(dir, n));
      const text = ctx.rd(path.join(dir, n));
      if (text == null) { notes.push(`${rel}: not read (binary or over ${MAX_FILE} bytes)`); continue; }
      if (!GIT_HOOKS.has(n)) continue;
      const narrowed = /git diff[^\n]*(--cached|--staged|--name-only)|staged_files|lint-staged|\$@|git diff-index|--diff-filter/.test(text);
      let found = 0;
      commandsOf(text.replace(/^#!.*\n/, "")).forEach((c) => {
        const e = entry(ctx, expand, "git-hook", rel, c, { hook: n, narrowed });
        if (e) { e.where = rel; entries.push(e); found++; }
      });
      if (!found) notes.push(`${rel}: a ${n} hook with no recognised check command in it (${text.split("\n").length} lines)`);
    }
  }
  for (const f of ["lefthook.yml", "lefthook.yaml", ".lefthook.yml"]) {
    const t = ctx.rd(f); if (!t) continue;
    const y = parseYaml(t) || {};
    for (const [hook, def] of Object.entries(y)) {
      if (!GIT_HOOKS.has(hook) || !def?.commands) continue;
      for (const [name, c] of Object.entries(def.commands)) {
        const run = c?.run; if (!run) continue;
        const e = entry(ctx, expand, "git-hook", `${f}:${hook}/${name}`, run, { hook, narrowed: !!(c.glob || /staged_files|push_files/.test(run)) });
        if (e) entries.push(e);
      }
    }
  }
  const pc = ctx.rd(".pre-commit-config.yaml");
  if (pc) {
    const y = parseYaml(pc) || {};
    for (const r of y.repos || []) for (const h of r.hooks || []) {
      entries.push({ trigger: "git-hook", where: `.pre-commit-config.yaml:${h.id}`, command: `pre-commit hook ${h.id}${h.entry ? ` (${h.entry})` : ""}`, key: `pre-commit hook ${h.id}`, keys: [`pre-commit hook ${h.id}`], kind: /fmt|format|black|isort|prettier/.test(h.id) ? "format" : /test/.test(h.id) ? "test" : "lint", runner: "pre-commit", scope: "narrow", hook: (h.stages && h.stages[0]) || "pre-commit", narrowed: h.pass_filenames !== "false" && h.always_run !== "true" });
    }
  }
  return { entries, notes };
}

/** Claude Code hooks (settings.json, settings.local.json, and the user's) that run a check. */
export function claudeHooks(ctx, expand, { user = true } = {}) {
  const entries = [], notes = [];
  const sources = [[path.join(ctx.root, ".claude/settings.json"), ".claude/settings.json", "project"], [path.join(ctx.root, ".claude/settings.local.json"), ".claude/settings.local.json", "project-local"]];
  if (user) sources.push([path.join(os.homedir(), ".claude/settings.json"), "~/.claude/settings.json", "user"]);
  for (const [file, label, scope] of sources) {
    let j; const text = ctx.rd(file);
    if (text == null) continue;
    try { j = JSON.parse(text); } catch { notes.push(`${label}: not valid JSON`); continue; }
    let total = 0, checks = 0;
    for (const [event, groups] of Object.entries(j.hooks || {})) for (const g of groups || []) for (const h of g.hooks || []) {
      if (h.type && h.type !== "command") { total++; continue; }
      const command = h.command || ""; total++;
      const sub = (s) => s.replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, ctx.root).replace(/\$\{?HOME\}?|^~(?=\/)/g, os.homedir());
      const script = tokens(command).map(sub).find((x) => /\.(sh|py|mjs|js|ts|rb)$/.test(x) || (x.startsWith("/") && x.includes("hooks")));
      const body = script ? ctx.rd(script) : null;
      const inline = commandsOf(command).map((c) => ({ c, cls: classify(c) })).filter((x) => x.cls && x.cls.kind !== "build");
      const inner = body ? commandsOf(body.replace(/^#!.*\n/, "")).map((c) => ({ c, cls: classify(c) })).filter((x) => x.cls && x.cls.kind !== "build") : [];
      const nameLooksLikeCheck = script && /(check|lint|test|gate|verify|audit|fmt|format)/i.test(path.basename(script));
      const where = `${label}:${event}${g.matcher ? `[${g.matcher}]` : ""}`;
      if (inline.length) for (const x of inline) { const e = entry(ctx, expand, "claude-hook", where, x.c, { event, matcher: g.matcher || null, hookScope: scope, timeout: h.timeout ?? null }); if (e) { entries.push(e); checks++; } }
      else if (inner.length || nameLooksLikeCheck) {
        entries.push({ trigger: "claude-hook", where, command: short(command, 160), key: normal(command), keys: [normal(command), ...inner.map((x) => normal(x.c))].filter((v, i, a) => a.indexOf(v) === i), kind: inner[0]?.cls.kind || "other", runner: script ? path.basename(script) : "hook", scope: "all", event, matcher: g.matcher || null, hookScope: scope, timeout: h.timeout ?? null, runs: inner.slice(0, 5).map((x) => short(x.c, 100)) });
        checks++;
      }
    }
    notes.push(`${label}: ${total} hook${total === 1 ? "" : "s"}, ${checks} run a check`);
  }
  return { entries, notes };
}

const pad = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
/** CI workflows: triggers and every job and step, with the check commands each step runs. */
export async function ciWorkflows(ctx, expand) {
  const files = (await ctx.files()).filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
  const workflows = [], entries = [], notes = [];
  const other = (await ctx.files()).filter((f) => /^(\.gitlab-ci\.yml|\.circleci\/config\.yml|azure-pipelines\.yml|Jenkinsfile|\.travis\.yml|bitbucket-pipelines\.yml|\.drone\.yml)$/.test(f));
  if (other.length) notes.push(`other CI definitions present and not read: ${other.join(", ")}`);
  for (const f of files) {
    let y; try { y = parseYaml(ctx.rd(f) || ""); } catch { y = null; }
    if (!y || typeof y !== "object") { notes.push(`${f}: could not be read`); continue; }
    const on = y.on ?? y["true"] ?? {};
    const events = [];
    if (typeof on === "string") events.push({ event: on });
    else if (Array.isArray(on)) for (const e of on) events.push({ event: e });
    else for (const [e, c] of Object.entries(on || {})) events.push({ event: e, branches: pad(c?.branches), paths: pad(c?.paths).length || undefined, pathsIgnore: pad(c?.["paths-ignore"]).length || undefined, cron: e === "schedule" ? pad(c).map((s) => s?.cron).filter(Boolean) : undefined });
    const triggers = events.map((e) => e.event + (e.branches?.length ? `(${e.branches.join(",")})` : "") + (e.paths ? ` paths:${e.paths}` : "") + (e.cron?.length ? ` cron:${e.cron.join("|")}` : "")).join(", ");
    const wf = { file: f, name: y.name || path.basename(f), triggers, events, jobs: [] };
    for (const [id, j] of Object.entries(y.jobs || {})) {
      const matrix = j?.strategy?.matrix && typeof j.strategy.matrix === "object" ? Object.fromEntries(Object.entries(j.strategy.matrix).map(([k, v]) => [k, Array.isArray(v) ? v.length : "…"])) : null;
      const job = { id, name: j?.name || id, uses: j?.uses || null, needs: pad(j?.needs), if: j?.if || null, runsOn: j?.["runs-on"] || null, matrix, timeoutMinutes: j?.["timeout-minutes"] || null, steps: [] };
      (j?.steps || []).forEach((s, i) => {
        const step = { name: s.name || (s.run ? "Run " + String(s.run).split("\n")[0] : s.uses ? "Run " + s.uses : `step ${i + 1}`), uses: s.uses || null, if: s.if || null, checks: [] };
        if (s.run) for (const c of commandsOf(String(s.run))) {
          const e = entry(ctx, expand, "ci", `${f}:${id}/${s.name || i + 1}`, c, { workflow: wf.name, workflowFile: f, job: job.name, jobId: id, step: step.name, triggers, workingDirectory: s["working-directory"] || null });
          if (e) { entries.push(e); step.checks.push(e.key); }
        } else if (s.uses && /(lint|test|check|audit|scan|codeql|review|deny|analy|coverage)/i.test(s.uses) && !/^actions\/(cache|checkout|upload|download|setup)/.test(s.uses)) {
          const e = { trigger: "ci", where: `${f}:${id}/${s.name || s.uses}`, command: `uses: ${s.uses}`, key: `uses ${s.uses.split("@")[0]}`, keys: [`uses ${s.uses.split("@")[0]}`], kind: /codeql|audit|scan|review|deny/i.test(s.uses) ? "audit" : "lint", runner: "action", scope: "all", workflow: wf.name, workflowFile: f, job: job.name, jobId: id, step: step.name, triggers };
          entries.push(e); step.checks.push(e.key);
        }
        job.steps.push(step);
      });
      wf.jobs.push(job);
    }
    workflows.push(wf);
  }
  return { workflows, entries, notes };
}

/** Instruction lines that tell a session to run a check. */
export async function instructionLines(ctx, expand, { user = false } = {}) {
  const files = (await ctx.files()).filter((f) =>
    !/(^|\/)(node_modules|worktrees|target|\.git)\//.test(f) &&
    (/(^|\/)(AGENTS|CLAUDE|CLAUDE\.local|CONTRIBUTING|GEMINI)\.md$/i.test(f) || /^\.claude\/(rules|agents|skills|fleet|commands)\/.+\.md$/.test(f) || /^\.github\/copilot-instructions\.md$/.test(f) || /^\.codex\/.+\.md$/.test(f)));
  const list = files.map((f) => ({ rel: f, abs: path.join(ctx.root, f), scope: scopeOfFile(f) }));
  if (user) {
    const home = os.homedir();
    list.push({ rel: "~/.claude/CLAUDE.md", abs: path.join(home, ".claude/CLAUDE.md"), scope: "user" });
    try { for (const n of fs.readdirSync(path.join(home, ".claude/rules"))) if (n.endsWith(".md")) list.push({ rel: `~/.claude/rules/${n}`, abs: path.join(home, ".claude/rules", n), scope: "user" }); } catch {}
  }
  const hits = []; let negated = 0;
  for (const f of list) {
    const text = ctx.rd(f.abs); if (!text) continue;
    let fence = false;
    text.split("\n").forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
      const found = [];
      if (fence) found.push(...commandsOf(line.replace(/^\s*\$\s+/, "")));
      else for (const m of line.matchAll(/`([^`\n]{3,200})`/g)) found.push(...commandsOf(m[1]));
      for (const c of found) {
        const e = entry(ctx, expand, "instruction", `${f.rel}:${i + 1}`, c, { dir: f.rel.startsWith(".claude/") || f.rel.startsWith("~") ? "" : path.dirname(f.rel) === "." ? "" : path.dirname(f.rel), fileScope: f.scope, fenced: fence || undefined, repeated: REPEATED.test(line), text: short(line.trim(), 200) });
        if (!e || e.kind === "build") continue;
        if (NEGATED.test(line)) { negated++; continue; }
        hits.push(e);
      }
    });
  }
  return { entries: hits, files: list.length, negated };
}
const scopeOfFile = (f) => (/^\.claude\/agents\//.test(f) ? "agent" : /^\.claude\/skills\//.test(f) ? "skill" : /^\.claude\/rules\//.test(f) ? "rule" : /^\.claude\/fleet\//.test(f) ? "fleet" : /AGENTS\.md$/i.test(f) ? "AGENTS.md" : /CLAUDE/.test(f) ? "CLAUDE.md" : "doc");
