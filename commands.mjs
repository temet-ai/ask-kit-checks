// Reading shell text: split it into commands, decide which commands are checks, and give each a
// normal form so the same command under different triggers compares equal.

const ENV = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;
const WRAPPERS = new Set(["sudo", "time", "xvfb-run", "timeout", "nice", "env", "exec", "command", "caffeinate"]);
const SKIP_START = /^(set|echo|printf|export|cd|if|then|else|elif|fi|for|while|do|done|case|esac|function|local|source|\.|read|exit|return|true|false|test|\[|\[\[|mkdir|cp|mv|rm|ln|cat|tee|touch|chmod|ls|pwd|trap|shift|unset|declare|readonly|eval|wait|sleep|git|curl|wget|tar|unzip|gh|docker|brew|apt|apt-get|rustup|python3?\s+-c|jq|sed|awk|grep|rg|find|xargs|head|tail|sort|uniq|cut|tr|wc|date|uname|which|type|hash)\b/;

const TEST_WORDS = /^(test|tests|test:\S*|check|check:\S*|lint|lint:\S*|typecheck|type-check|types|tsc|fmt|format|format:\S*|fmt-check|verify|e2e|e2e:\S*|coverage|audit|gate|validate|vet|unit|integration|smoke|spec|test-\S+|lint-\S+|check-\S+|storybook-test|a11y|stylelint|eslint|prettier)$/i;
const TOOLS = {
  pytest: "test", tox: "test", nox: "test", vitest: "test", jest: "test", mocha: "test", playwright: "test", cypress: "test", ava: "test", rspec: "test", phpunit: "test", nextest: "test",
  ruff: "lint", flake8: "lint", pylint: "lint", eslint: "lint", oxlint: "lint", biome: "lint", stylelint: "lint", shellcheck: "lint", actionlint: "lint", hadolint: "lint", markdownlint: "lint", yamllint: "lint", rubocop: "lint", "golangci-lint": "lint", codespell: "lint", typos: "lint", lychee: "lint", "svelte-check": "typecheck", mypy: "typecheck", pyright: "typecheck", tsc: "typecheck",
  black: "format", isort: "format", prettier: "format", shfmt: "format", gitleaks: "audit", semgrep: "audit", trivy: "audit", "ast-grep": "lint", sg: "lint", "cargo-deny": "audit", "pip-audit": "audit", bandit: "audit",
};
const CARGO = { test: "test", nextest: "test", clippy: "lint", fmt: "format", check: "typecheck", deny: "audit", audit: "audit", machete: "lint", udeps: "lint", miri: "test", bench: "test", "llvm-cov": "test", hack: "test", "semver-checks": "lint", mutants: "test", doc: "lint", vet: "audit", build: "build" };
const SCRIPT_WORDS = /(check|lint|test|gate|verify|audit|validate|fmt|format|coverage|sanity|smoke|preflight|policy|compliance|contract)/i;

/** Split shell text into commands: continuation lines joined, comments and && ; | separators removed. */
export function commandsOf(text) {
  const out = [];
  const joined = String(text).replace(/\r/g, "").replace(/\\\n\s*/g, " ");
  for (let line of joined.split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    line = line.replace(/\s#\s.*$/, "");
    for (let part of line.split(/\s*(?:&&|\|\||;|\|)\s*/)) {
      part = part.trim().replace(/\s*\\$/, "").replace(/^[!({]\s*/, "").replace(/^(then|do|else)\s+/, "").replace(/[)}]+$/, "").replace(/\s+(>>?|2>)\s*\S+$/, "").replace(/\s+2>&1$/, "").trim();
      if (part && !part.startsWith("#")) out.push(part);
    }
  }
  return out;
}

export const tokens = (cmd) => {
  const t = cmd.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  let i = 0;
  while (i < t.length && (ENV.test(t[i]) || WRAPPERS.has(t[i]))) { if (t[i] === "timeout") i++; i++; }
  return t.slice(i).map((x) => x.replace(/^["']|["']$/g, ""));
};

/** The normal form: env assignments, leading ./, colour and quiet flags removed. */
export function normal(cmd) {
  const t = tokens(cmd).filter((x) => !/^--(color(=\S*)?|locked|frozen|frozen-lockfile|quiet|offline|verbose|no-fail-fast)$/.test(x) && x !== "-q" && x !== "-v");
  if ((t[0] === "bash" || t[0] === "sh") && t[1] && !t[1].startsWith("-")) t.shift();
  if (t[0]) t[0] = t[0].replace(/^\.\//, "");
  return t.join(" ").replace(/\s+/g, " ").trim();
}

/** Is this command a check? Returns { kind, runner } or null. kind: test|lint|format|typecheck|audit|build|other. */
export function classify(cmd) {
  const t = tokens(cmd);
  if (!t.length) return null;
  if (/^[<$]/.test(t[0])) return null;
  const a = t[0].replace(/^\.\//, ""), base = a.split("/").pop();
  if (SKIP_START.test(a + " " + (t[1] || "")) && !/^(git|gh|docker)$/.test(a)) {
    if (!/^(cd|echo|set|export)$/.test(a)) { /* fall through to the checks below for pip-style names */ }
    else return null;
  }
  if (a === "git" || a === "gh" || a === "docker") {
    if (a === "git" && (t[1] === "diff" && t.includes("--check"))) return { kind: "lint", runner: "git diff --check" };
    return null;
  }
  const word = (w) => (w || "").replace(/^--?/, "");
  if (a === "cargo") {
    const sub = t.find((x, i) => i > 0 && !x.startsWith("+") && !x.startsWith("-")) || "";
    return CARGO[sub] ? { kind: CARGO[sub], runner: `cargo ${sub}` } : null;
  }
  if (/^(npm|pnpm|yarn|bun)$/.test(a)) {
    const rest = t.slice(1).filter((x, i, arr) => !/^(--prefix|-C|--dir|--cwd|--filter|-F|-w|--workspace)$/.test(x) && !/^(--prefix|-C|--dir|--cwd|--filter|-F|-w|--workspace)$/.test(arr[i - 1] || "") && !/^--(prefix|dir|cwd|filter|workspace)=/.test(x));
    const s = rest[0] === "run" || rest[0] === "run-script" ? rest[1] : rest[0];
    if (!s) return null;
    if (/^(exec|dlx|x)$/.test(s)) { const tool = (rest[rest.indexOf(s) + 1] || ""); if (/^(install|install-deps|show-report|codegen)$/.test(rest[rest.indexOf(s) + 2] || "")) return null; return TOOLS[tool] ? { kind: TOOLS[tool], runner: `${a} ${s} ${tool}` } : null; }
    if (s === "audit") return { kind: "audit", runner: `${a} audit` };
    if (s === "test" || s === "t") return { kind: "test", runner: `${a} test` };
    if (/^build/.test(s)) return { kind: "build", runner: `${a} run ${s}` };
    if (TEST_WORDS.test(s)) return { kind: /fmt|format|prettier/.test(s) ? "format" : /lint|eslint|stylelint/.test(s) ? "lint" : /type|tsc|svelte-check/.test(s) ? "typecheck" : "test", runner: `${a} run ${s}` };
    if (/^(storybook|sb)\S*test|test\S*|\S*:test|\S*-test$/.test(s)) return { kind: "test", runner: `${a} run ${s}` };
    return null;
  }
  if (a === "npx" || a === "bunx") { const ti = t.findIndex((x, i) => i > 0 && !x.startsWith("-")); const tool = t[ti]; if (/^(install|install-deps|show-report|codegen)$/.test(t[ti + 1] || "")) return null; return TOOLS[tool] ? { kind: TOOLS[tool], runner: `npx ${tool}` } : null; }
  if (a === "node" && (t.includes("--test") || t.some((x) => /^--test/.test(x)))) return { kind: "test", runner: "node --test" };
  if (a === "node" && t.includes("--check")) return { kind: "lint", runner: "node --check" };
  if (a === "node" && t[1] && !t[1].startsWith("<") && (/(^|\/)(tests?|spec|__tests__)\//.test(t[1]) || SCRIPT_WORDS.test(t[1].split("/").pop()))) return { kind: kindOfName(t[1]), runner: `node ${t[1]}` };
  if (/^python3?$/.test(a)) {
    if (t[1] === "-m" && t[2]) { const m = t[2]; if (TOOLS[m]) return { kind: TOOLS[m], runner: `python -m ${m}` }; if (m === "unittest") return { kind: "test", runner: "python -m unittest" }; return null; }
    if (t[1] && SCRIPT_WORDS.test(t[1].split("/").pop())) return { kind: kindOfName(t[1]), runner: `python ${t[1]}` };
    return null;
  }
  if (a === "uv" && t[1] === "run") return classify(t.slice(2).join(" "));
  if (a === "go" && /^(test|vet)$/.test(t[1] || "")) return { kind: t[1] === "vet" ? "lint" : "test", runner: `go ${t[1]}` };
  if (a === "deno" && /^(test|lint|fmt|check)$/.test(t[1] || "")) return { kind: t[1] === "fmt" ? "format" : t[1] === "test" ? "test" : t[1] === "check" ? "typecheck" : "lint", runner: `deno ${t[1]}` };
  if (/^(mvn|mvnw|gradle|gradlew|\.\/gradlew)$/.test(base) && t.some((x) => /^(test|verify|check)$/.test(x))) return { kind: "test", runner: base };
  if (a === "dotnet" && /^(test|format)$/.test(t[1] || "")) return { kind: t[1] === "test" ? "test" : "format", runner: `dotnet ${t[1]}` };
  if (a === "bundle" && t[1] === "exec" && TOOLS[t[2]]) return { kind: TOOLS[t[2]], runner: `bundle exec ${t[2]}` };
  if (a === "make" || a === "gmake" || a === "just" || a === "task" || (a === "mise" && t[1] === "run")) {
    const target = t.slice(1).find((x) => !x.startsWith("-") && !x.includes("=") && x !== "run");
    return target && (TEST_WORDS.test(target) || SCRIPT_WORDS.test(target)) ? { kind: kindOfName(target), runner: `${a} ${target}` } : null;
  }
  if (a === "pre-commit" && t[1] === "run") return { kind: "lint", runner: "pre-commit run" };
  if (a === "lefthook" && t[1] === "run") return { kind: "lint", runner: "lefthook run" };
  if (a === "lint-staged") return { kind: "lint", runner: "lint-staged" };
  if (a === "terraform" && /^(validate|fmt)$/.test(t[1] || "")) return { kind: "lint", runner: `terraform ${t[1]}` };
  if (TOOLS[base] && /^(install|install-deps|show-report|codegen|open|init|help)$/.test(t[1] || "")) return null;
  if (TOOLS[base]) return { kind: TOOLS[base], runner: base };
  if (/^(rustfmt)$/.test(base)) return { kind: "format", runner: base };
  if (/^(bash|sh|zsh)$/.test(a)) { const f = t.find((x, i) => i > 0 && !x.startsWith("-")); return f && SCRIPT_WORDS.test(f.split("/").pop()) ? { kind: kindOfName(f), runner: f } : null; }
  if ((a.includes("/") || a.startsWith("./")) && SCRIPT_WORDS.test(base) && !/\.(md|json|jsonl|ya?ml|toml|txt|mjs|cjs|js|ts|rs|html|css|log|csv|xml|lock|svg|png)$/i.test(base)) return { kind: kindOfName(base), runner: a.replace(/^\.\//, "") };
  return null;
}
function kindOfName(n) {
  n = n.split("/").pop();
  if (/fmt|format/i.test(n)) return "format";
  if (/lint|policy|compliance/i.test(n)) return "lint";
  if (/type/i.test(n)) return "typecheck";
  if (/audit/i.test(n)) return "audit";
  return "test";
}

const NARROW = /(^|\s)(-p\b|--package\b|-E\b|--filter\b|--test\b|--lib\b|--bin\b|--example\b|--doc\b|-k\b|-t\b|--grep\b|--changed|--staged|--since|--only|--related|--findRelatedTests|-- \S)/;
/** "all" when a check covers the whole workspace or project, "narrow" when it names a package, test or path. */
export function scopeOf(cmd) {
  const c = normal(cmd);
  { const t0 = tokens(cmd); if (t0[0] === "node" && t0.includes("--check")) return t0.length > 2 ? "narrow" : "all"; if (/^(node|python3?)$/.test(t0[0]) && t0.filter((x) => !x.startsWith("-")).length > 2) return "narrow"; }
  if (/(--workspace|--all\b|test-all|\bmake (check|gate|ci|test)\b)/.test(c)) return "all";
  if (NARROW.test(" " + c)) return "narrow";
  const t = tokens(cmd);
  const pathArg = t.slice(1).some((x) => /[\/.]/.test(x) && !x.startsWith("-") && !/^(run|test|fmt|check)$/.test(x) && !/^(npm|pnpm|yarn)$/.test(t[0]));
  if (/^(npm|pnpm|yarn|bun)$/.test(t[0])) return "all";
  return pathArg && !/^(bash|sh|python3?|node)$/.test(t[0]) && !t[0].includes("/") ? "narrow" : "all";
}

/** Does text that names a check also forbid or warn against running it? */
export const NEGATED = /\b(never|do not|don't|dont|avoid|instead of|rather than|not to run|no need to|skip|without running|stop running|must not|should not|shouldn't|banned|forbidden)\b/i;
export const REPEATED = /\b(every|each|always|after (each|every|any|all)|before (each|every|any|commit|committing|push|pushing|merge|merging|you (commit|push|finish|report|hand))|on every|whenever|again|re-?run|until)\b/i;
