import { randomUUID } from "node:crypto";
import { PluginHost, ERR, RpcError, defaultsOf } from "./host.js";

const ACTION_CAP = {
  reply: "reply",
  editMessage: "editMessage",
  addRole: "addRole",
  removeRole: "addRole",
  kick: "kick",
  emit: "emit",
  schedule: "scheduler",
};

const EPHEMERAL_OK = new Set(["reply"]);

/**
 * Router: dono de todos os hosts, valida Action[] e executa no adapter.
 * Não sabe o que é discord.js — só conversa com a interface do adapter.
 */
export class Router {
  constructor({ store, adapter, log = () => {} }) {
    this.store = store;
    this.adapter = adapter;
    this.hosts = new Map();
    this.log = log;
    this.topicSubs = new Map();
    this.schedules = [];
    this.startedAt = Date.now();
  }

  /* ── carregamento ── */

  async load() {
    const plugins = this.store.listPlugins();
    const installs = this.store.listAllGuildInstalls();
    for (const plugin of plugins) {
      const guilds = installs
        .filter((i) => i.pluginId === plugin.id && i.enabled)
        .map((i) => ({ id: i.guildId, config: i.config, caps: i.caps }));
      const approved = [...new Set(guilds.flatMap((g) => g.caps))];
      this.register(plugin, guilds, approved);
    }
    this.rebuildTopicSubs();
    return this;
  }

  register(plugin, guilds, approvedCaps) {
    const existing = this.hosts.get(plugin.id);
    if (existing) existing.shutdown("reload");

    const host = new PluginHost({
      plugin: withManifest(plugin, guilds, approvedCaps),
      store: this.store,
      log: this.log,
      handlers: this.handlers(),
    });
    this.hosts.set(plugin.id, host);
    return host;
  }

  host(pluginId) {
    return this.hosts.get(pluginId) ?? null;
  }

  /** recarrega do banco: usado depois de instalar/remover/ativar plugin */
  async reload() {
    const plugins = this.store.listPlugins();
    const keep = new Set(plugins.map((p) => p.id));
    for (const [id, host] of this.hosts) {
      if (!keep.has(id)) { await host.shutdown("plugin removido"); this.hosts.delete(id); }
    }
    const installs = this.store.listAllGuildInstalls();
    for (const plugin of plugins) {
      const guilds = installs
        .filter((i) => i.pluginId === plugin.id && i.enabled)
        .map((i) => ({ id: i.guildId, config: i.config, caps: i.caps }));
      const approved = [...new Set(guilds.flatMap((g) => g.caps))];
      const existing = this.hosts.get(plugin.id);
      if (existing && !existing.degraded) {
        // atualiza dados sem derrubar o processo
        existing.plugin = {
          ...withManifest(plugin, guilds, approved),
        };
        continue;
      }
      this.register(plugin, guilds, approved);
    }
    this.rebuildTopicSubs();
    return this;
  }

  rebuildTopicSubs() {
    this.topicSubs.clear();
    for (const [, host] of this.hosts) {
      for (const topic of host.plugin.manifest?.subscribes ?? []) {
        if (!this.topicSubs.has(topic)) this.topicSubs.set(topic, []);
        this.topicSubs.get(topic).push(host);
      }
    }
  }

  handlers() {
    return {
      kvGet: (p, g, k) => this.store.kvGet(p, g, k),
      kvSet: (p, g, k, v) => { this.store.kvSet(p, g, k, v); return v; },
      kvDel: (p, g, k) => this.store.kvDel(p, g, k),
      kvKeys: (p, g, prefix) => this.store.kvKeys(p, g, prefix),
      econGet: (g, u) => this.store.econGet(g, u),
      econGrant: (g, u, a) => this.store.econGrant(g, u, a),
      econTop: (g, l) => this.store.econTop(g, l),
      httpFetch: async (plugin, { url, method = "GET", body, headers }) => {
        const allowed = plugin.manifest?.allowed_hosts ?? plugin.manifest?.allowedHosts ?? [];
        const host = new URL(url).hostname;
        if (!allowed.some((a) => a === host || (a.startsWith("*.") && host.endsWith(a.slice(1))))) {
          throw new Error(`host "${host}" não está em allowed_hosts`);
        }
        const res = await fetch(url, { method, body, headers, signal: AbortSignal.timeout(8000) });
        const text = await res.text();
        return { status: res.status, body: text.slice(0, 20000) };
      },
    };
  }

  /* ── despacho ── */

  async dispatchCommand({ command, args = [], guildId, userId, channelId, messageId, isInteraction = false }) {
    const candidates = [];
    for (const [, host] of this.hosts) {
      const p = host.plugin;
      if (!p.enabled) continue;
      if (!p.commands.some((c) => c.name === command)) continue;
      if (!p.guilds.some((g) => g.id === guildId)) continue;
      candidates.push(host);
    }
    if (!candidates.length) return { handled: false, reason: "comando não registrado nesta guild" };

    const results = [];
    for (const host of candidates) {
      results.push(await this.invoke(host, "handleCommand", {
        command, args, guildId, userId, channelId, messageId, isInteraction,
      }, { guildId, userId, channelId, messageId, isInteraction }));
    }
    return { handled: results.some((r) => r.ok), results };
  }

  async dispatchEvent({ type, guildId, payload }) {
    const subs = [];
    for (const [, host] of this.hosts) {
      const p = host.plugin;
      if (!p.enabled) continue;
      if (!p.events.includes(type)) continue;
      if (!p.guilds.some((g) => g.id === guildId)) continue;
      subs.push(host);
    }
    const results = [];
    for (const host of subs) {
      results.push(await this.invoke(host, "handleEvent", { type, guildId, payload }, {
        guildId, userId: payload?.userId, channelId: payload?.channelId, messageId: payload?.messageId,
      }));
    }
    return { subscribers: subs.length, results };
  }

  async publish(topic, payload) {
    const targets = this.topicSubs.get(topic) ?? [];
    const results = [];
    for (const host of targets) {
      results.push(await this.invoke(host, "handleEvent", { type: "CUSTOM", guildId: payload?.guildId, payload: { topic, ...payload } }, {}));
    }
    return results;
  }

  /* ── invocação + execução de actions ── */

  async invoke(host, method, params, ctx) {
    const requestId = randomUUID().slice(0, 8);
    const started = Date.now();
    let actions;

    try {
      await host.ensureStarted();
      actions = await host.call(method, params, undefined, requestId);
    } catch (err) {
      const ok = false;
      this.store.stat(host.plugin.id, method, ok, Date.now() - started, err.message);
      this.store.log({
        pluginId: host.plugin.id, guildId: ctx.guildId ?? null, level: "error",
        source: "core", requestId, message: `${method}: ${err.message}`,
      });
      return { ok, error: err.message, code: err.code ?? null, requestId };
    }

    const duration = Date.now() - started;
    const list = Array.isArray(actions) ? actions : [];
    const valid = [];

    for (const action of list) {
      const check = this.validateAction(host, action, ctx);
      if (check.ok) valid.push(action);
      else {
        this.store.stat(host.plugin.id, `${method}:invalid`, false, duration, check.reason);
        this.store.log({
          pluginId: host.plugin.id, guildId: ctx.guildId ?? null, level: "warn",
          source: "capability", requestId, message: `ação ${action?.type} recusada: ${check.reason}`,
        });
      }
    }

    this.store.stat(host.plugin.id, method, true, duration, null);

    const executed = [];
    for (const action of valid) {
      try {
        const res = await this.execute(host, action, ctx, requestId);
        executed.push({ action, result: res });
      } catch (err) {
        this.store.log({
          pluginId: host.plugin.id, guildId: ctx.guildId ?? null, level: "error",
          source: "core", requestId, message: `falha ao executar ${action.type}: ${err.message}`,
        });
        executed.push({ action, error: err.message });
      }
    }

    return { ok: true, actions: list.length, executed, requestId, durationMs: duration };
  }

  validateAction(host, action, ctx) {
    if (!action || typeof action !== "object" || typeof action.type !== "string") {
      return { ok: false, reason: "ação sem type" };
    }
    const cap = ACTION_CAP[action.type];
    if (!cap) return { ok: false, reason: `tipo desconhecido "${action.type}"` };

    const install = host.plugin.guilds.find((g) => g.id === ctx.guildId);
    if (!install) return { ok: false, reason: "plugin não instalado nesta guild" };
    if (!install.caps.includes(cap)) return { ok: false, reason: `capability "${cap}" não aprovada` };

    if (action.type === "reply" || action.type === "editMessage") {
      if (typeof action.content !== "string" || !action.content.trim()) return { ok: false, reason: "content vazio" };
      if (action.content.length > 2000) action.content = action.content.slice(0, 1999) + "…";
      if (action.type === "editMessage" && typeof action.messageId !== "string") return { ok: false, reason: "messageId obrigatório" };
      if (action.ephemeral && !EPHEMERAL_OK.has(action.type)) return { ok: false, reason: "ephemeral só vale em reply" };
    }
    if (action.type === "addRole" || action.type === "removeRole") {
      if (typeof action.userId !== "string" || typeof action.roleId !== "string") return { ok: false, reason: "userId e roleId obrigatórios" };
    }
    if (action.type === "kick" && typeof action.userId !== "string") return { ok: false, reason: "userId obrigatório" };
    if (action.type === "emit" && typeof action.topic !== "string") return { ok: false, reason: "topic obrigatório" };
    if (action.type === "schedule") {
      if (typeof action.in !== "string" || typeof action.run !== "string") return { ok: false, reason: "in e run obrigatórios" };
    }
    return { ok: true };
  }

  async execute(host, action, ctx, requestId) {
    const d = this.adapter;
    switch (action.type) {
      case "reply":
        return d.sendMessage({
          guildId: ctx.guildId,
          channelId: action.channelId ?? ctx.channelId,
          content: action.content,
          ephemeral: !!action.ephemeral && !!ctx.isInteraction,
          interactionId: ctx.isInteraction ? ctx.messageId : null,
          pluginId: host.plugin.id,
        });
      case "editMessage":
        return d.editMessage({ channelId: ctx.channelId, messageId: action.messageId, content: action.content });
      case "addRole":
        return d.addRole({ guildId: ctx.guildId, userId: action.userId, roleId: action.roleId });
      case "removeRole":
        return d.removeRole({ guildId: ctx.guildId, userId: action.userId, roleId: action.roleId });
      case "kick":
        return d.kick({ guildId: ctx.guildId, userId: action.userId, reason: action.reason ?? "" });
      case "emit": {
        const subs = this.topicSubs.get(action.topic) ?? [];
        setImmediate(() => {
          for (const target of subs) {
            this.invoke(target, "handleEvent", {
              type: "CUSTOM", guildId: ctx.guildId,
              payload: { topic: action.topic, ...(action.payload ?? {}), guildId: ctx.guildId },
            }, { guildId: ctx.guildId }).catch(() => {});
          }
        });
        return { topic: action.topic, subscribers: subs.length };
      }
      case "schedule": {
        const ms = parseDuration(action.in);
        const entry = setTimeout(() => {
          this.schedules = this.schedules.filter((s) => s !== entry);
          const host2 = this.hosts.get(host.plugin.id);
          if (!host2) return;
          this.invoke(host2, "handleEvent", {
            type: "SCHEDULE", guildId: ctx.guildId,
            payload: { run: action.run, ...(action.payload ?? {}) },
          }, { guildId: ctx.guildId }).catch(() => {});
        }, ms);
        this.schedules.push(entry);
        return { in: action.in, ms };
      }
      default:
        throw new Error(`tipo não tratado: ${action.type}`);
    }
  }

  async healthAll() {
    const out = [];
    for (const [id, host] of this.hosts) {
      const stats = this.store.pluginStats(id);
      let alive = host.alive;
      let detail = null;
      if (host.plugin.enabled && !host.degraded) {
        try {
          const r = await host.call("health", {}, 1500, randomUUID().slice(0, 8));
          detail = r;
          alive = true;
        } catch (err) {
          detail = { error: err.message };
          alive = false;
        }
      }
      out.push({ id, alive, degraded: host.degraded, restarts: host.restarts, stats, detail });
    }
    return out;
  }

  async stopAll() {
    for (const [, host] of this.hosts) await host.shutdown("core shutdown");
    for (const t of this.schedules) clearTimeout(t);
  }
}

/** Manifesto achatado no registro do plugin: comandos/eventos no topo. */
function withManifest(plugin, guilds, approved) {
  const m = plugin.manifest ?? {};
  return {
    ...plugin,
    commands: m.commands ?? [],
    events: m.events ?? [],
    subscribes: m.subscribes ?? [],
    guilds,
    runtime: { ...plugin.runtime, enabledCaps: approved },
  };
}

export function parseDuration(str) {
  const m = /^(\d+)\s*(ms|s|m|h|d)$/.exec(String(str).trim());
  if (!m) throw new Error(`duração inválida: ${str}`);
  const n = Number(m[1]);
  return n * { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
}
