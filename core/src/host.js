import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export const ERR = {
  TIMEOUT: -32001,
  CRASH: -32002,
  CAPABILITY: -32003,
  PROTOCOL: -32004,
  INVALID_ACTION: -32005,
};

const IDLE_MS = 15 * 60 * 1000;
const MAX_RESTARTS = 3;

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/**
 * Um processo por plugin. Chamadas serializadas (plugins costumam ser single-thread).
 * O plugin pode chamar o core de volta (kv, economy, log) pelo mesmo canal.
 */
export class PluginHost {
  constructor({ plugin, store, handlers, log }) {
    this.plugin = plugin;
    this.store = store;
    this.handlers = handlers;       // { kvGet, kvSet, ..., economyGet, ... }
    this.log = log;
    this.child = null;
    this.pending = new Map();       // id -> { resolve, reject, timer }
    this.seq = 0;
    this.queue = Promise.resolve();
    this.restarts = 0;
    this.degraded = false;
    this.ready = false;
    this.stderrBuf = [];
    this.lastUsed = Date.now();
    this.callTimeoutMs = plugin.runtime.timeoutMs ?? 3000;
    this.instanceId = Math.random().toString(36).slice(2, 8);
  }

  get alive() {
    return this.child && this.child.exitCode === null && !this.child.killed;
  }

  async ensureStarted() {
    if (this.degraded) throw new RpcError(ERR.CRASH, "plugin est\u00e1 em estado degradado");
    if (this.alive && this.ready) return;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      if (!this.alive) await this.spawnChild();
      // rawCall direto: um this.call() aqui entraria na fila atrás de si mesmo
      await this.rawCall(`init-${this.instanceId}`, "initialize", {
        pluginId: this.plugin.id,
        version: this.plugin.version,
        capabilities: this.plugin.runtime.enabledCaps ?? [],
        guilds: this.plugin.guilds ?? [],
        core: { version: "0.1.0", protocol: 1 },
      }, 5000);
      this.ready = true;
      this.restarts = 0;
    })().finally(() => { this.starting = null; });

    return this.starting;
  }

  spawnChild() {
    const rt = this.plugin.runtime;
    const [cmd, ...args] = rt.cmd;
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG ?? "C.UTF-8",
      PYTHONUNBUFFERED: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONPATH: rt.cwd ?? process.cwd(),
      NODE_OPTIONS: "",
      BOT_PLUGIN_ID: this.plugin.id,
      BOT_PLUGIN_VERSION: this.plugin.version,
      BOT_GUILDS: JSON.stringify((this.plugin.guilds ?? []).map((g) => g.id)),
    };

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(cmd, args, {
          cwd: rt.cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
        });
      } catch (err) {
        return reject(new RpcError(ERR.CRASH, `falha ao iniciar: ${err.message}`));
      }

      this.child = child;
      this.ready = false;
      this.lastUsed = Date.now();

      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on("line", (line) => this.onLine(line));

      createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (line) => {
        this.store.log({
          pluginId: this.plugin.id, level: "info", source: "plugin",
          message: line, requestId: this.currentRequestId ?? null,
        });
      });

      child.on("error", (err) => {
        this.store.log({ pluginId: this.plugin.id, level: "error", source: "core", message: `processo: ${err.message}` });
      });

      child.on("exit", (code, signal) => {
        const wasReady = this.ready;
        this.ready = false;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new RpcError(ERR.CRASH, `processo encerrou durante a chamada (code ${code}, ${signal ?? "sem sinal"})`));
        }
        this.pending.clear();
        if (!this.shuttingDown) {
          this.store.log({
            pluginId: this.plugin.id, level: code === 0 ? "info" : "error", source: "core",
            message: `processo encerrou com código ${code}${signal ? ` (${signal})` : ""}`,
          });
          if (wasReady) this.scheduleRecovery();
        }
      });

      // primeiro flush de stdout confirma que subiu
      const t = setTimeout(() => resolve(), 250);
      child.once("spawn", () => { clearTimeout(t); resolve(); });
      child.once("error", () => { clearTimeout(t); reject(new RpcError(ERR.CRASH, "processo não iniciou")); });
    });
  }

  scheduleRecovery() {
    this.restarts++;
    this.store.setPluginStatus(this.plugin.id, this.restarts >= MAX_RESTARTS ? "degraded" : "restarting", { restarts: this.restarts });
    if (this.restarts >= MAX_RESTARTS) {
      this.degraded = true;
      this.store.log({ pluginId: this.plugin.id, level: "error", source: "core", message: `${MAX_RESTARTS} reinícios seguidos. Plugin marcado como degradado.` });
      return;
    }
    const delay = 1000 * 2 ** (this.restarts - 1);
    this.store.log({ pluginId: this.plugin.id, level: "warn", source: "core", message: `reinício ${this.restarts} de ${MAX_RESTARTS} em ${delay} ms` });
  }

  onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.store.log({
        pluginId: this.plugin.id, level: "warn", source: "protocol",
        message: `linha inválida em stdout: ${trimmed.slice(0, 160)}`,
      });
      return;
    }

    if (!msg || typeof msg !== "object") return;

    if (typeof msg.method === "string") return void this.onPluginRequest(msg);
    return void this.onPluginResponse(msg);
  }

  onPluginResponse(msg) {
    const p = this.pending.get(msg.id);
    if (!p) {
      this.store.log({ pluginId: this.plugin.id, level: "warn", source: "protocol", message: `resposta com id desconhecido: ${String(msg.id)}` });
      return;
    }
    clearTimeout(p.timer);
    p.timer = null;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new RpcError(msg.error.code ?? -32000, msg.error.message ?? "erro do plugin", msg.error.data));
    else p.resolve(msg.result);
  }

  onPluginRequest(msg) {
    const reply = (result) => this.write({ jsonrpc: "2.0", id: msg.id, result });
    const fail = (code, message) => this.write({ jsonrpc: "2.0", id: msg.id, error: { code, message } });

    const run = async () => {
      const method = msg.method;
      const params = msg.params ?? {};
      const guildId = String(params.guildId ?? "");
      const required = CAPABILITY_FOR[method];

      if (required && !this.hasCap(guildId, required)) {
        this.store.log({
          pluginId: this.plugin.id, guildId, level: "warn", source: "capability", requestId: this.currentRequestId,
          message: `chamada ${method} negada: capability "${required}" não aprovada`,
        });
        return fail(ERR.CAPABILITY, `capability "${required}" não aprovada nesta guild`);
      }

      try {
        switch (method) {
          case "kv.get": return reply({ value: this.handlers.kvGet(this.plugin.id, guildId, params.key) });
          case "kv.set": return reply({ ok: true, value: this.handlers.kvSet(this.plugin.id, guildId, params.key, params.value) });
          case "kv.del": return reply({ deleted: this.handlers.kvDel(this.plugin.id, guildId, params.key) });
          case "kv.keys": return reply({ keys: this.handlers.kvKeys(this.plugin.id, guildId, params.prefix ?? "") });
          case "kv.incr": {
            const cur = Number(await this.handlers.kvGet(this.plugin.id, guildId, params.key)) || 0;
            const next = cur + (Number(params.by) || 1);
            this.handlers.kvSet(this.plugin.id, guildId, params.key, next);
            return reply({ value: next });
          }
          case "economy.get": return reply({ balance: this.handlers.econGet(guildId, params.userId) });
          case "economy.grant": {
            if (typeof params.amount !== "number" || !Number.isFinite(params.amount)) throw new Error("amount inválido");
            const balance = this.handlers.econGrant(guildId, params.userId, Math.round(params.amount));
            this.store.log({ pluginId: this.plugin.id, guildId, level: "info", source: "economy", requestId: this.currentRequestId, message: `${params.userId} ${params.amount > 0 ? "+" : ""}${params.amount} → ${balance}` });
            return reply({ balance });
          }
          case "economy.top": return reply({ entries: this.handlers.econTop(guildId, params.limit ?? 10) });
          case "config.get": return reply({ config: this.guildConfig(guildId) });
          case "log": {
            this.store.log({
              pluginId: this.plugin.id, guildId: guildId || null,
              level: params.level ?? "info", source: "plugin",
              message: String(params.message ?? ""), requestId: this.currentRequestId,
            });
            return reply({ ok: true });
          }
          case "http.fetch": return reply(await this.handlers.httpFetch(this.plugin, params));
          default:
            this.store.log({ pluginId: this.plugin.id, level: "warn", source: "protocol", message: `método desconhecido: ${method}` });
            return fail(-32601, `método não suportado: ${method}`);
        }
      } catch (err) {
        return fail(-32000, err.message);
      }
    };

    run().catch((err) => fail(-32000, err.message));
  }

  hasCap(guildId, cap) {
    const install = (this.plugin.guilds ?? []).find((g) => g.id === guildId);
    if (!install) return false;
    return install.caps.includes(cap);
  }

  guildConfig(guildId) {
    const install = (this.plugin.guilds ?? []).find((g) => g.id === guildId);
    return { ...defaultsOf(this.plugin.manifest), ...(install?.config ?? {}) };
  }

  write(obj) {
    if (!this.alive) return false;
    try { this.child.stdin.write(JSON.stringify(obj) + "\n"); return true; }
    catch { return false; }
  }

  /** chamada serializada, com timeout */
  call(method, params, timeoutMs = this.callTimeoutMs, requestId = null) {
    const run = async () => {
      this.lastUsed = Date.now();
      if (!this.alive) await this.ensureStarted();
      this.currentRequestId = requestId;
      const id = `core-${++this.seq}`;
      try {
        return await this.rawCall(id, method, params, timeoutMs);
      } finally {
        this.currentRequestId = null;
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  rawCall(id, method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.write({ jsonrpc: "2.0", id, method, params })) {
        return reject(new RpcError(ERR.CRASH, "não foi possível escrever no processo"));
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.store.log({ pluginId: this.plugin.id, level: "error", source: "core", message: `${method} excedeu ${timeoutMs} ms` });
        reject(new RpcError(ERR.TIMEOUT, `${method} excedeu ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  async shutdown(reason = "manual") {
    this.shuttingDown = true;
    if (this.alive) {
      try { this.write({ jsonrpc: "2.0", id: `core-${++this.seq}`, method: "shutdown", params: { reason } }); } catch {}
      await new Promise((r) => setTimeout(r, 120));
      try { this.child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { this.child?.kill("SIGKILL"); } catch {} }, 800);
    }
    this.child = null;
    this.ready = false;
  }

  reset() {
    this.degraded = false;
    this.restarts = 0;
    this.shuttingDown = false;
    this.store.setPluginStatus(this.plugin.id, "healthy", { enabled: true, restarts: 0 });
  }

  maybeIdleKill() {
    if (this.alive && Date.now() - this.lastUsed > IDLE_MS) {
      this.store.log({ pluginId: this.plugin.id, level: "info", source: "core", message: "encerrado por inatividade" });
      this.shutdown("idle");
    }
  }
}

const CAPABILITY_FOR = {
  "kv.get": "kv", "kv.set": "kv", "kv.del": "kv", "kv.keys": "kv", "kv.incr": "kv",
  "economy.get": "economy.read", "economy.top": "economy.read",
  "economy.grant": "economy.grant",
  "http.fetch": "http",
};

export function defaultsOf(manifest) {
  const out = {};
  for (const [k, v] of Object.entries(manifest.config ?? {})) if (v.default !== undefined) out[k] = v.default;
  return out;
}
