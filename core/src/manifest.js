/**
 * Parser TOML mínimo — só o subconjunto que o manifesto usa.
 * Chaves, strings, números, booleanos, arrays, tabelas e arrays de tabelas.
 */
export function parseToml(text) {
  const root = {};
  let cur = root;
  const lines = text.split(/\r?\n/);
  let buf = "";
  let bufStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripComment(raw).trim();
    if (!buf && !line) continue;
    buf = buf ? buf + "\n" + line : line;

    if (unbalanced(buf)) continue;

    const stmt = buf.trim();
    buf = "";
    if (!stmt) continue;

    if (stmt.startsWith("[[") && stmt.endsWith("]]")) {
      const path = stmt.slice(2, -2).trim().split(".").map(unquote);
      let node = root;
      for (const k of path.slice(0, -1)) {
        node[k] ??= {};
        node = node[k];
      }
      const last = path[path.length - 1];
      node[last] ??= [];
      const t = {};
      node[last].push(t);
      cur = t;
      continue;
    }

    if (stmt.startsWith("[") && stmt.endsWith("]")) {
      const path = stmt.slice(1, -1).trim().split(".").map(unquote);
      let node = root;
      for (const k of path) {
        if (Array.isArray(node[k])) node = node[k][node[k].length - 1];
        else {
          node[k] ??= {};
          node = node[k];
        }
      }
      cur = node;
      continue;
    }

    const eq = findAssign(stmt);
    if (eq < 0) throw new Error(`linha ${i + 1}: esperava chave = valor, recebi "${stmt}"`);
    const key = stmt.slice(0, eq).trim();
    const value = stmt.slice(eq + 1).trim();
    cur[unquote(key)] = parseValue(value, i + 1);
  }

  return root;
}

function stripComment(line) {
  let out = "";
  let quote = null;
  let esc = false;
  for (const ch of line) {
    if (esc) { out += ch; esc = false; continue; }
    if (ch === "\\") { out += ch; esc = true; continue; }
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (ch === "#") break;
    out += ch;
  }
  return out;
}

function unbalanced(s) {
  let depth = 0, quote = null, esc = false;
  for (const ch of s) {
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
  }
  return depth > 0 || quote !== null;
}

function findAssign(s) {
  let quote = null, esc = false, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (ch === "=" && depth === 0) return i;
  }
  return -1;
}

function unquote(s) {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

function parseValue(v, line) {
  v = v.trim();
  if (v === "") throw new Error(`linha ${line}: valor vazio`);
  if (v.startsWith('"""') && v.endsWith('"""')) return v.slice(3, -3);
  if (v.startsWith('"') && v.endsWith('"')) return JSON.parse(expandEscapes(v));
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^[+-]?\d+$/.test(v)) return Number.parseInt(v, 10);
  if (/^[+-]?\d*\.\d+$/.test(v)) return Number.parseFloat(v);
  if (v.startsWith("[")) return parseArray(v, line);
  if (v.startsWith("{")) return parseInlineTable(v, line);
  return v;
}

function expandEscapes(s) {
  // JSON.parse aceita \n \t \" \\ \uXXXX; TOML usa os mesmos para o subconjunto que precisamos
  return s;
}

function splitTop(s, sep = ",") {
  const parts = [];
  let quote = null, esc = false, depth = 0, acc = "";
  for (const ch of s) {
    if (esc) { acc += ch; esc = false; continue; }
    if (ch === "\\") { acc += ch; esc = true; continue; }
    if (quote) { acc += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; acc += ch; continue; }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (ch === sep && depth === 0) { parts.push(acc); acc = ""; continue; }
    acc += ch;
  }
  if (acc.trim()) parts.push(acc);
  return parts;
}

function parseArray(v, line) {
  const inner = v.slice(1, -1);
  return splitTop(inner).map((p) => parseValue(p, line));
}

function parseInlineTable(v, line) {
  const inner = v.slice(1, -1);
  const out = {};
  for (const part of splitTop(inner)) {
    const eq = findAssign(part);
    if (eq < 0) throw new Error(`linha ${line}: tabela inline inválida`);
    out[unquote(part.slice(0, eq))] = parseValue(part.slice(eq + 1), line);
  }
  return out;
}

/** Valida e normaliza o manifesto. Lança erro legível. */
export function normalizeManifest(m, source = "plugin.toml") {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };

  need(typeof m.name === "string" && m.name.length > 0, `${source}: "name" é obrigatório`);
  need(typeof m.version === "string" && /^\d+\.\d+\.\d+/.test(m.version ?? ""), `${source}: "version" deve ser semver (ex: 1.0.0)`);
  need(m.commands === undefined || Array.isArray(m.commands), `${source}: "commands" deve ser array de tabelas`);
  need(m.events === undefined || Array.isArray(m.events), `${source}: "events" deve ser array`);
  need(m.capabilities === undefined || Array.isArray(m.capabilities), `${source}: "capabilities" deve ser array`);

  const runtime = m.runtime ?? {};
  const kind = runtime.kind ?? "process";
  need(["process", "container"].includes(kind), `${source}: runtime.kind deve ser "process" ou "container"`);
  if (kind === "process") need(Array.isArray(runtime.cmd) && runtime.cmd.length > 0, `${source}: runtime.cmd é obrigatório para kind = "process"`);
  if (kind === "container") need(typeof runtime.image === "string" && runtime.image.includes("/"), `${source}: runtime.image é obrigatório para kind = "container"`);

  const commands = (m.commands ?? []).map((c) => {
    need(typeof c.name === "string" && /^[a-z0-9_-]{1,32}$/.test(c.name ?? ""), `${source}: comando inválido "${c.name}" (use a-z, 0-9, - e _)`);
    return { name: c.name, description: c.description ?? "", options: c.options ?? [] };
  });
  const names = new Set();
  for (const c of commands) {
    need(!names.has(c.name), `${source}: comando duplicado "${c.name}"`);
    names.add(c.name);
  }

  const caps = [...new Set(m.capabilities ?? [])];
  const known = ["reply", "replyEphemeral", "editMessage", "addRole", "removeRole", "kick", "kv", "economy", "economy.read", "economy.grant", "scheduler", "http", "emit"];
  for (const c of caps) need(known.includes(c), `${source}: capability desconhecida "${c}"`);

  if (errors.length) {
    const err = new Error(errors.join("\n"));
    err.code = "E_MANIFEST";
    err.details = errors;
    throw err;
  }

  return {
    id: m.name,
    name: m.display_name ?? titleCase(m.name),
    version: m.version,
    description: m.description ?? "",
    lang: m.lang ?? "unknown",
    capabilities: caps,
    commands,
    events: [...new Set(m.events ?? [])],
    subscribes: [...new Set(m.subscribes ?? [])],
    config: m.config ?? {},
    allowedHosts: m.allowed_hosts ?? [],
    runtime: {
      kind,
      cmd: runtime.cmd ?? [],
      cwd: runtime.cwd ?? ".",
      build: runtime.build ?? null,
      image: runtime.image ?? null,
      port: runtime.port ?? null,
      timeoutMs: runtime.timeout_ms ?? 3000,
    },
    raw: m,
  };
}

function titleCase(s) {
  return String(s).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
