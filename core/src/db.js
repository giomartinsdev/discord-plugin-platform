import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS plugin (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    version       TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    repo_url      TEXT,
    branch        TEXT DEFAULT 'main',
    commit_sha    TEXT,
    lang          TEXT NOT NULL DEFAULT 'unknown',
    runtime_kind  TEXT NOT NULL DEFAULT 'process',
    runtime_json  TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'healthy',
    enabled       INTEGER NOT NULL DEFAULT 1,
    restarts      INTEGER NOT NULL DEFAULT 0,
    installed_at  INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS plugin_guild (
    plugin_id TEXT NOT NULL,
    guild_id  TEXT NOT NULL,
    enabled   INTEGER NOT NULL DEFAULT 1,
    config    TEXT NOT NULL DEFAULT '{}',
    approved_caps TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (plugin_id, guild_id)
  )`,
  `CREATE TABLE IF NOT EXISTS kv (
    plugin_id  TEXT NOT NULL,
    guild_id   TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (plugin_id, guild_id, key)
  )`,
  `CREATE TABLE IF NOT EXISTS economy (
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    balance    INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS event_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    plugin_id  TEXT,
    guild_id   TEXT,
    level      TEXT NOT NULL,
    source     TEXT NOT NULL,
    message    TEXT NOT NULL,
    request_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_log_ts ON event_log(ts DESC)`,
  `CREATE TABLE IF NOT EXISTS call_stat (
    plugin_id  TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    method     TEXT NOT NULL,
    ok         INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    error      TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_stat_ts ON call_stat(ts DESC)`,
  `CREATE TABLE IF NOT EXISTS setting (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of MIGRATIONS) db.exec(sql);
  return db;
}

export const defaultDbPath = () => join(process.cwd(), ".data", "platform.db");

/* ── plugins ── */
export const db = {};

export function createStore(file) {
  const raw = openDb(file);
  const all = (sql, ...params) => raw.prepare(sql).all(...params);
  const get = (sql, ...params) => raw.prepare(sql).get(...params);
  const run = (sql, ...params) => raw.prepare(sql).run(...params);

  return {
    raw,

    listPlugins() {
      return all("SELECT * FROM plugin ORDER BY installed_at ASC").map(hydrate);
    },
    getPlugin(id) {
      const row = get("SELECT * FROM plugin WHERE id = ?", id);
      return row ? hydrate(row) : null;
    },
    upsertPlugin(p) {
      const now = Date.now();
      run(
        `INSERT INTO plugin (id, name, version, description, repo_url, branch, commit_sha, lang,
           runtime_kind, runtime_json, manifest_json, status, enabled, restarts, installed_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, version=excluded.version, description=excluded.description,
           repo_url=excluded.repo_url, branch=excluded.branch, commit_sha=excluded.commit_sha,
           lang=excluded.lang, runtime_kind=excluded.runtime_kind, runtime_json=excluded.runtime_json,
           manifest_json=excluded.manifest_json, updated_at=excluded.updated_at`,
        p.id, p.name, p.version, p.description ?? "", p.repoUrl ?? null, p.branch ?? "main",
        p.commitSha ?? null, p.lang ?? "unknown", p.runtime.kind, JSON.stringify(p.runtime),
        JSON.stringify(p.manifest), p.status ?? "healthy", p.enabled === false ? 0 : 1,
        p.restarts ?? 0, now, now,
      );
      return this.getPlugin(p.id);
    },
    setPluginStatus(id, status, { enabled, restarts } = {}) {
      const cur = this.getPlugin(id);
      if (!cur) return null;
      run("UPDATE plugin SET status=?, enabled=?, restarts=?, updated_at=? WHERE id=?",
        status ?? cur.status, (enabled ?? cur.enabled) ? 1 : 0, restarts ?? cur.restarts, Date.now(), id);
      return this.getPlugin(id);
    },
    deletePlugin(id) {
      run("DELETE FROM plugin WHERE id=?", id);
      run("DELETE FROM plugin_guild WHERE plugin_id=?", id);
      run("DELETE FROM kv WHERE plugin_id=?", id);
    },

    /* guild install */
    listGuildInstalls(pluginId) {
      return all("SELECT * FROM plugin_guild WHERE plugin_id=? ORDER BY guild_id", pluginId)
        .map((r) => ({ guildId: r.guild_id, enabled: !!r.enabled, config: JSON.parse(r.config), caps: JSON.parse(r.approved_caps) }));
    },
    listAllGuildInstalls() {
      return all("SELECT * FROM plugin_guild ORDER BY guild_id").map((r) => ({
        pluginId: r.plugin_id, guildId: r.guild_id, enabled: !!r.enabled,
        config: JSON.parse(r.config), caps: JSON.parse(r.approved_caps),
      }));
    },
    installToGuild(pluginId, guildId, caps, config = {}) {
      run(`INSERT INTO plugin_guild (plugin_id, guild_id, enabled, config, approved_caps)
           VALUES (?,?,1,?,?)
           ON CONFLICT(plugin_id, guild_id) DO UPDATE SET
             enabled=1, config=excluded.config, approved_caps=excluded.approved_caps`,
        pluginId, guildId, JSON.stringify(config), JSON.stringify(caps));
    },
    uninstallFromGuild(pluginId, guildId) {
      run("DELETE FROM plugin_guild WHERE plugin_id=? AND guild_id=?", pluginId, guildId);
    },
    setGuildConfig(pluginId, guildId, config) {
      run("UPDATE plugin_guild SET config=? WHERE plugin_id=? AND guild_id=?", JSON.stringify(config), pluginId, guildId);
    },

    /* kv */
    kvGet(pluginId, guildId, key) {
      const row = get("SELECT value FROM kv WHERE plugin_id=? AND guild_id=? AND key=?", pluginId, guildId, key);
      return row ? JSON.parse(row.value) : undefined;
    },
    kvSet(pluginId, guildId, key, value) {
      run(`INSERT INTO kv (plugin_id, guild_id, key, value, updated_at) VALUES (?,?,?,?,?)
           ON CONFLICT(plugin_id, guild_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        pluginId, guildId, key, JSON.stringify(value), Date.now());
    },
    kvDel(pluginId, guildId, key) {
      return run("DELETE FROM kv WHERE plugin_id=? AND guild_id=? AND key=?", pluginId, guildId, key).changes > 0;
    },
    kvKeys(pluginId, guildId, prefix = "") {
      return all("SELECT key FROM kv WHERE plugin_id=? AND guild_id=? AND key LIKE ? ORDER BY key",
        pluginId, guildId, prefix + "%").map((r) => r.key);
    },
    kvCount(pluginId) {
      return get("SELECT COUNT(*) c FROM kv WHERE plugin_id=?", pluginId)?.c ?? 0;
    },

    /* economia */
    econGet(guildId, userId) {
      return get("SELECT balance FROM economy WHERE guild_id=? AND user_id=?", guildId, userId)?.balance ?? 0;
    },
    econGrant(guildId, userId, amount) {
      run(`INSERT INTO economy (guild_id, user_id, balance, updated_at) VALUES (?,?,?,?)
           ON CONFLICT(guild_id, user_id) DO UPDATE SET balance=balance+excluded.balance, updated_at=excluded.updated_at`,
        guildId, userId, amount, Date.now());
      return this.econGet(guildId, userId);
    },
    econTop(guildId, limit = 10) {
      return all("SELECT user_id, balance FROM economy WHERE guild_id=? ORDER BY balance DESC LIMIT ?", guildId, limit)
        .map((r) => ({ userId: r.user_id, balance: r.balance }));
    },

    /* logs */
    log({ pluginId = null, guildId = null, level = "info", source = "core", message, requestId = null }) {
      run("INSERT INTO event_log (ts, plugin_id, guild_id, level, source, message, request_id) VALUES (?,?,?,?,?,?,?)",
        Date.now(), pluginId, guildId, level, source, String(message), requestId);
    },
    logs({ pluginId, limit = 200, sinceId = 0 }) {
      const rows = pluginId
        ? all("SELECT * FROM event_log WHERE plugin_id=? AND id>? ORDER BY id DESC LIMIT ?", pluginId, sinceId, limit)
        : all("SELECT * FROM event_log WHERE id>? ORDER BY id DESC LIMIT ?", sinceId, limit);
      return rows.map((r) => ({
        id: r.id, ts: r.ts, pluginId: r.plugin_id, guildId: r.guild_id,
        level: r.level, source: r.source, message: r.message, requestId: r.request_id,
      }));
    },

    /* estatísticas */
    stat(pluginId, method, ok, durationMs, error = null) {
      run("INSERT INTO call_stat (plugin_id, ts, method, ok, duration_ms, error) VALUES (?,?,?,?,?,?)",
        pluginId, Date.now(), method, ok ? 1 : 0, Math.round(durationMs), error);
    },
    pluginStats(pluginId, windowMs = 86400000) {
      const since = Date.now() - windowMs;
      const agg = get(`SELECT COUNT(*) calls, SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) errs,
        AVG(duration_ms) avg FROM call_stat WHERE plugin_id=? AND ts>?`, pluginId, since);
      const rows = all("SELECT duration_ms FROM call_stat WHERE plugin_id=? AND ts>? ORDER BY duration_ms", pluginId, since);
      const p95 = rows.length ? rows[Math.min(rows.length - 1, Math.floor(rows.length * 0.95))].duration_ms : 0;
      return { calls: agg?.calls ?? 0, errors: agg?.errs ?? 0, avg: Math.round(agg?.avg ?? 0), p95 };
    },
    hourlyVolume(hours = 24) {
      const now = Date.now();
      const bucket = 3600000;
      const start = now - hours * bucket;
      const rows = all("SELECT ts FROM call_stat WHERE ts>?", start);
      const out = Array.from({ length: hours }, () => 0);
      for (const r of rows) {
        const idx = Math.min(hours - 1, Math.floor((r.ts - start) / bucket));
        out[idx]++;
      }
      return out;
    },

    setting(key, fallback = null) {
      const row = get("SELECT value FROM setting WHERE key=?", key);
      return row ? JSON.parse(row.value) : fallback;
    },
    setSetting(key, value) {
      run("INSERT INTO setting (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, JSON.stringify(value));
    },
  };
}

function hydrate(row) {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description,
    repoUrl: row.repo_url,
    branch: row.branch,
    commitSha: row.commit_sha,
    lang: row.lang,
    runtime: JSON.parse(row.runtime_json),
    manifest: JSON.parse(row.manifest_json),
    status: row.status,
    enabled: !!row.enabled,
    restarts: row.restarts,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  };
}
