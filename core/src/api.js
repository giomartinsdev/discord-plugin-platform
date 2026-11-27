import { createServer } from "node:http";
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, extname, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadLocalPackage, readManifestFromDir, cloneRepo, isRepoUrl } from "./loader.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "..", "..", "prototype", "index.html");

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

/**
 * API HTTP + serve o protótipo. Zero dependência.
 */
export function createApi({ store, router, adapter, core }) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    const json = (code, data) => {
      const body = JSON.stringify(data, null, 2);
      res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, cors());
      return res.end();
    }

    try {
      if (path === "/" || path === "/index.html") return sendStatic(res, PUBLIC);
      if (path.startsWith("/api/")) return await api(req, res, url, { store, router, adapter, core, json });
      return json(404, { error: "não encontrado" });
    } catch (err) {
      json(500, { error: err.message, code: err.code ?? null, stack: process.env.DEBUG ? err.stack : undefined });
    }
  });

  function sendStatic(res, file) {
    if (!existsSync(file)) { res.writeHead(404); return res.end("não encontrado"); }
    const type = MIME[extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
    res.end(readFileSync(file));
  }
}

function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
    ...{ "content-type": "application/json" },
  };
}

async function api(req, res, url, ctx) {
  const { store, router, adapter, json } = ctx;
  const p = url.pathname.replace(/^\/api/, "");
  const seg = p.split("/").filter(Boolean);
  const method = req.method;

  const body = await readBody(req);

  /* ── status ── */
  if (p === "/status" && method === "GET") {
    const plugins = store.listPlugins();
    const active = plugins.filter((x) => x.enabled);
    const totalCalls = plugins.reduce((a, x) => a + store.pluginStats(x.id).calls, 0);
    const errors = plugins.reduce((a, x) => a + store.pluginStats(x.id).errors, 0);
    return json(200, {
      adapter: adapter.kind,
      uptimeMs: Date.now() - router.startedAt,
      version: "0.1.0",
      protocol: 1,
      plugins: { total: plugins.length, active: active.length },
      calls24h: totalCalls,
      errors24h: errors,
      kvKeys: plugins.reduce((a, x) => a + store.kvCount(x.id), 0),
      volume: store.hourlyVolume(24),
    });
  }

  /* ── plugins ── */
  if (p === "/plugins" && method === "GET") {
    return json(200, store.listPlugins().map((pl) => serializePlugin(store, router, pl)));
  }

  if (p === "/plugins" && method === "POST") {
    const result = await ctx.core.install(body);
    return json(201, result);
  }

  if (seg[0] === "plugins" && seg[1]) {
    const id = seg[1];
    const plugin = store.getPlugin(id);
    if (!plugin) return json(404, { error: `plugin "${id}" não existe` });

    if (seg.length === 2 && method === "GET") return json(200, serializePlugin(store, router, plugin));

    if (seg.length === 2 && method === "PATCH") {
      if (typeof body.enabled === "boolean") {
        store.setPluginStatus(id, body.enabled ? "healthy" : "stopped", { enabled: body.enabled });
        const host = router.host(id);
        if (!body.enabled) await host?.shutdown("desativado pelo painel");
        else host?.reset();
        await router.reload();
        await ctx.core.syncCommands().catch(() => {});
      }
      return json(200, serializePlugin(store, router, store.getPlugin(id)));
    }

    if (seg.length === 2 && method === "DELETE") {
      await router.host(id)?.shutdown("removido");
      store.deletePlugin(id);
      await router.reload();
      await ctx.core.syncCommands().catch(() => {});
      return json(200, { deleted: true });
    }

    if (seg[2] === "refresh" && method === "POST") {
      try {
        return json(200, await ctx.core.refresh(id));
      } catch (err) {
        return json(400, { error: err.message, code: err.code ?? null });
      }
    }

    if (seg[2] === "commands" && method === "GET") {
      return json(200, {
        commands: plugin.manifest?.commands ?? [],
        overrides: ctx.core.commandOverrides(id) ?? [],
      });
    }

    if (seg[2] === "commands" && method === "PUT") {
      const list = Array.isArray(body.commands) ? body.commands : [];
      const known = new Set((plugin.manifest?.commands ?? []).map((c) => c.name));
      for (const c of list) {
        if (!known.has(c.name)) return json(400, { error: `comando "${c.name}" não existe neste plugin` });
        if (c.alias && !/^[a-z0-9_-]{1,32}$/.test(c.alias)) {
          return json(400, { error: `apelido inválido "${c.alias}": use a-z, 0-9, - e _` });
        }
        const on = list.filter((x) => x.enabled !== false);
        if (on.length === 0) return json(400, { error: "o plugin precisa de pelo menos um comando ativo" });
      }
      const aliases = list.filter((c) => c.alias).map((c) => c.alias);
      if (new Set(aliases).size !== aliases.length) return json(400, { error: "dois comandos com o mesmo apelido" });
      return json(200, await ctx.core.setCommandOverrides(id, list));
    }

    if (seg[2] === "logs" && method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 200);
      return json(200, store.logs({ pluginId: id, limit }));
    }

    if (seg[2] === "config" && method === "PATCH") {
      const guildId = body.guildId;
      if (!guildId) return json(400, { error: "guildId obrigatório" });
      store.setGuildConfig(id, guildId, body.config ?? {});
      const host = router.host(id);
      if (host) {
        const install = host.plugin.guilds.find((g) => g.id === guildId);
        if (install) install.config = body.config ?? {};
        await host.call("initialize", {
          pluginId: id, version: plugin.version, guilds: host.plugin.guilds,
          capabilities: host.plugin.runtime.enabledCaps ?? [], core: { version: "0.1.0", protocol: 1 },
        }).catch(() => {});
      }
      return json(200, { ok: true });
    }

    if (seg[2] === "guilds" && method === "POST") {
      store.installToGuild(id, body.guildId, body.caps ?? plugin.manifest.capabilities ?? [], body.config ?? {});
      router.reload();
      return json(200, { ok: true });
    }

    if (seg[2] === "guilds" && seg[3] && method === "DELETE") {
      store.uninstallFromGuild(id, seg[3]);
      router.reload();
      return json(200, { ok: true });
    }

    if (seg[2] === "restart" && method === "POST") {
      const host = router.host(id);
      if (host) { await host.shutdown("restart"); host.reset(); }
      router.reload();
      return json(200, { ok: true });
    }

    /* chamada direta — console do painel */
    if (seg[2] === "call" && method === "POST") {
      const host = router.host(id);
      if (!host) return json(404, { error: "plugin não carregado" });
      const guildId = body.guildId ?? store.listGuildInstalls(id)[0]?.guildId ?? "1";
      const payload = { ...body.params, guildId };
      if (body.method === "handleCommand") {
        const r = await router.dispatchCommand({
          command: body.params?.command ?? "ping", args: body.params?.args ?? [],
          guildId, userId: body.params?.userId ?? "1", channelId: "1", isInteraction: false,
        });
        return json(200, r);
      }
      try {
        const result = await host.call(body.method, payload, undefined, randomUUID().slice(0, 8));
        return json(200, { result });
      } catch (err) {
        return json(200, { error: { code: err.code ?? -32000, message: err.message } });
      }
    }

    if (seg[2] === "health" && method === "POST") {
      const host = router.host(id);
      if (!host) return json(404, { error: "plugin não carregado" });
      try { return json(200, { result: await host.call("health", {}, 2000) }); }
      catch (err) { return json(200, { error: err.message }); }
    }
  }

  /* ── guilds ── */
  if (p === "/guilds" && method === "GET") {
    const installs = store.listAllGuildInstalls();
    const ids = [...new Set(installs.map((i) => i.guildId))];
    return json(200, ctx.core.guilds.map((g) => ({
      ...g,
      plugins: installs.filter((i) => i.guildId === g.id).map((i) => ({
        pluginId: i.pluginId, enabled: i.enabled, caps: i.caps,
        config: i.config, name: store.getPlugin(i.pluginId)?.name ?? i.pluginId,
      })),
    })).concat(ids.filter((id) => !ctx.core.guilds.some((g) => g.id === id)).map((id) => ({
      id, name: id, plugins: installs.filter((i) => i.guildId === id).map((i) => ({ pluginId: i.pluginId, enabled: i.enabled, caps: i.caps, config: i.config, name: store.getPlugin(i.pluginId)?.name ?? i.pluginId })),
    }))));
  }

  /* ── logs ── */
  if (p === "/logs" && method === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? 200);
    const pluginId = url.searchParams.get("plugin") || undefined;
    const level = url.searchParams.get("level") || undefined;
    let rows = store.logs({ pluginId, limit: Math.min(limit, 1000) });
    if (level) rows = rows.filter((r) => r.level === level);
    return json(200, rows);
  }

  /* ── economia ── */
  if (seg[0] === "economy" && method === "GET") {
    const guildId = seg[1] ?? "1201";
    return json(200, { guildId, top: store.econTop(guildId, Number(url.searchParams.get("limit") ?? 10)) });
  }
  if (p === "/economy/grant" && method === "POST") {
    return json(200, { balance: store.econGrant(body.guildId, body.userId, body.amount) });
  }

  /* ── simulação: dispara evento/comando pelo adapter mock ── */
  if (p === "/simulate/command" && method === "POST") {
    const guildId = body.guildId ?? ctx.core.guilds[0]?.id ?? "1201";
    return json(200, await router.dispatchCommand({
      command: body.command, args: body.args ?? [], guildId,
      userId: body.userId ?? "dev-user", channelId: body.channelId ?? "dev-channel",
      messageId: `sim-${Date.now()}`, isInteraction: false,
    }));
  }

  if (p === "/simulate/event" && method === "POST") {
    const guildId = body.guildId ?? ctx.core.guilds[0]?.id ?? "1201";
    return json(200, await router.dispatchEvent({ type: body.type, guildId, payload: body.payload ?? {} }));
  }

  if (p === "/health" && method === "GET") {
    return json(200, await router.healthAll());
  }

  /* ── conformidade ── */
  if (p === "/conformance" && method === "POST") {
    return json(200, await ctx.core.conformance(body.dir));
  }

  /* ── inspeção de diretório ou repositório sem instalar (assistente) ── */
  if (p === "/inspect" && method === "POST") {
    if (!body.dir && !body.url) return json(400, { error: "informe o diretório ou a URL do repositório" });
    let tmp = null;
    try {
      let target = body.dir;
      if (body.url) {
        if (!isRepoUrl(body.url)) return json(400, { error: "a URL precisa ser de um repositório git (https, ssh ou git@)" });
        // clone descartável: só para ler o manifesto, é apagado no fim
        tmp = mkdtempSync(join(tmpdir(), "plugin-inspect-"));
        target = cloneRepo(body.url, { workDir: tmp, branch: body.branch });
      }
      const pkg = loadLocalPackage(resolve(target), { build: false });
      return json(200, {
        id: pkg.manifest.id,
        name: pkg.manifest.name,
        version: pkg.manifest.version,
        description: pkg.manifest.description,
        lang: pkg.lang,
        dir: tmp ?? pkg.dir,
        fromRepo: !!body.url,
        commitSha: pkg.commitSha,
        branch: pkg.branch,
        repoUrl: body.url ?? pkg.repoUrl,
        capabilities: pkg.manifest.capabilities,
        commands: pkg.manifest.commands,
        events: pkg.manifest.events,
        config: pkg.manifest.config,
        runtime: pkg.runtime,
        alreadyInstalled: store.getPlugin(pkg.manifest.id) !== null,
      });
    } catch (err) {
      return json(400, { error: err.message, details: err.details ?? null, code: err.code ?? null });
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  }

  /* ── lista diretórios de plugin no repo (assistente) ── */
  if (p === "/sources" && method === "GET") {
    const dir = join(ctx.core.root, "plugins");
    const entries = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [];
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = join(dir, e.name);
      if (!existsSync(join(full, "plugin.toml"))) continue;
      try {
        const m = readManifestFromDir(full);
        out.push({
          dir: full, id: m.id, name: m.name, version: m.version,
          lang: m.lang, description: m.description,
          capabilities: m.capabilities, commands: m.commands,
          installed: store.getPlugin(m.id) !== null,
        });
      } catch { /* manifesto inválido: aparece só como diretório */ }
    }
    return json(200, out);
  }

  /* ── reinicia todos ── */
  if (p === "/restart" && method === "POST") {
    for (const plugin of store.listPlugins()) {
      const host = router.host(plugin.id);
      if (host) { await host.shutdown("restart global"); host.reset(); }
    }
    await router.reload();
    return json(200, { ok: true, restarted: store.listPlugins().length });
  }

  return json(404, { error: `rota não encontrada: ${req.method} ${p}` });
}

function serializePlugin(store, router, pl) {
  const host = router.host(pl.id);
  const stats = store.pluginStats(pl.id);
  const installs = store.listGuildInstalls(pl.id);
  // comandos efetivos: manifesto + apelidos/desligados do painel
  const commands = host?.plugin?.commands ?? pl.manifest.commands ?? [];
  return {
    id: pl.id,
    name: pl.name,
    version: pl.version,
    description: pl.description,
    repoUrl: pl.repoUrl,
    branch: pl.branch,
    commitSha: pl.commitSha,
    source: store.setting(`source:${pl.id}`, null),
    commandOverrides: store.setting(`commands:${pl.id}`, null) ?? [],
    lang: pl.lang,
    runtime: { kind: pl.runtime.kind, cmd: pl.runtime.cmd, image: pl.runtime.image ?? null },
    capabilities: pl.manifest.capabilities ?? [],
    commands,
    events: pl.manifest.events ?? [],
    configSchema: pl.manifest.config ?? {},
    status: host?.degraded ? "degraded" : pl.status,
    enabled: pl.enabled,
    alive: !!host?.alive,
    restarts: pl.restarts,
    guilds: installs,
    stats: { calls24h: stats.calls, errors24h: stats.errors, p95: stats.p95, avg: stats.avg },
    kvKeys: store.kvCount(pl.id),
    manifest: pl.manifest,
  };
}

async function readBody(req) {
  if (req.method === "GET" || req.method === "DELETE") return {};
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try { return JSON.parse(text); }
  catch { const err = new Error("JSON inválido no corpo"); err.code = "E_BAD_JSON"; throw err; }
}
