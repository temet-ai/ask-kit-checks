// A small reader for the YAML that CI workflows, lefthook and pre-commit files use: maps, lists,
// block scalars (| and >), flow lists, quoted strings. No anchors, tags or multi-document files.
// Values stay strings ("22.x", "true"); a key with no value is null.
export function parseYaml(text) {
  const lines = String(text).replace(/\r/g, "").split("\n");
  let pos = 0;
  const indentOf = (s) => s.match(/^ */)[0].length;
  const stripComment = (s) => {
    let q = null;
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (q) { if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
      else if (c === "#" && (k === 0 || /\s/.test(s[k - 1]))) return s.slice(0, k);
    }
    return s;
  };
  const blank = (s) => stripComment(s).trim() === "" || /^(---|\.\.\.)\s*$/.test(s);
  const skipBlank = () => { while (pos < lines.length && blank(lines[pos])) pos++; };
  const splitFlow = (s) => {
    const out = []; let depth = 0, q = null, cur = "";
    for (const c of s) {
      if (q) { cur += c; if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === "[" || c === "{") depth++;
      if (c === "]" || c === "}") depth--;
      if (c === "," && depth === 0) { out.push(cur); cur = ""; continue; }
      cur += c;
    }
    if (cur.trim()) out.push(cur);
    return out;
  };
  const scalar = (v) => {
    v = v.trim();
    if (v === "" || v === "~" || v === "null") return null;
    if (v[0] === '"' && v.endsWith('"') && v.length > 1) return v.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    if (v[0] === "'" && v.endsWith("'") && v.length > 1) return v.slice(1, -1).replace(/''/g, "'");
    if (v[0] === "[" && v.endsWith("]")) return splitFlow(v.slice(1, -1)).map(scalar);
    if (v[0] === "{" && v.endsWith("}")) {
      const o = {};
      for (const part of splitFlow(v.slice(1, -1))) { const m = part.match(/^\s*([^:]+?)\s*:\s*(.*)$/); if (m) o[m[1].replace(/^["']|["']$/g, "")] = scalar(m[2]); }
      return o;
    }
    return v;
  };
  const KEY = /^("[^"]*"|'[^']*'|[^\s:#"'\-\[{][^:]*?|-[^\s:][^:]*?):(?:\s+(.*))?$/;
  const parseNode = (min) => {
    skipBlank();
    if (pos >= lines.length) return null;
    const line = lines[pos], ind = indentOf(line);
    if (ind < min) return null;
    const t = line.slice(ind);
    if (t === "-" || t.startsWith("- ")) return parseList(ind);
    if (KEY.test(stripComment(t).trimEnd())) return parseMap(ind);
    pos++;
    return scalar(stripComment(t));
  };
  const parseList = (ind) => {
    const out = [];
    for (;;) {
      skipBlank();
      if (pos >= lines.length) break;
      const line = lines[pos];
      if (indentOf(line) !== ind || !(line.slice(ind) === "-" || line.slice(ind).startsWith("- "))) break;
      const rest = line.slice(ind + 1).replace(/^ /, "");
      const lead = line.slice(ind + 1).length - line.slice(ind + 1).trimStart().length;
      if (rest.trim() === "" || blank(rest)) { pos++; out.push(parseNode(ind + 1)); continue; }
      const probe = stripComment(rest).trimEnd();
      if (KEY.test(probe) && !(probe[0] === '"' && probe.endsWith('"')) && !(probe[0] === "[")) {
        lines[pos] = " ".repeat(ind + 1 + lead) + rest.trimStart();
        out.push(parseMap(ind + 1 + lead));
      } else { pos++; out.push(scalar(probe)); }
    }
    return out;
  };
  const parseMap = (ind) => {
    const o = {};
    for (;;) {
      skipBlank();
      if (pos >= lines.length) break;
      const line = lines[pos];
      if (indentOf(line) !== ind) break;
      const t = stripComment(line.slice(ind)).trimEnd();
      if (t === "-" || t.startsWith("- ")) break;
      const m = t.match(KEY);
      if (!m) { pos++; continue; }
      const key = m[1].replace(/^["']|["']$/g, "");
      const rest = (m[2] ?? "").trim();
      if (/^[|>][+-]?\d*$/.test(rest)) {
        pos++;
        const body = [];
        let bi = null;
        while (pos < lines.length) {
          const l = lines[pos];
          if (l.trim() === "") { body.push(""); pos++; continue; }
          const li = indentOf(l);
          if (li <= ind) break;
          if (bi === null) bi = li;
          body.push(l.slice(Math.min(bi, li)));
          pos++;
        }
        while (body.length && body[body.length - 1] === "") body.pop();
        o[key] = rest[0] === ">" ? body.join(" ").replace(/ {2,}/g, " ") : body.join("\n");
      } else if (rest === "") {
        pos++;
        skipBlank();
        if (pos < lines.length && indentOf(lines[pos]) > ind) o[key] = parseNode(ind + 1);
        else if (pos < lines.length && indentOf(lines[pos]) === ind && /^- |^-$/.test(lines[pos].slice(ind))) o[key] = parseList(ind);
        else o[key] = null;
      } else { pos++; o[key] = scalar(rest); }
    }
    return o;
  };
  return parseNode(0);
}
