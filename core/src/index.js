import { join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { createStore, defaultDbPath } from "./db.js";
import { Router } from "./router.js";
import { MockAdapter } from "./adapters/mock.js";
import { DiscordAdapter } from "./adapters/discord.js";
import { loadLocalPackage, cloneRepo, pullRepo, isRepoUrl, slugFromUrl, readManifestFromDir } from "./loader.js";
import { runConformance } from "./conformance.js";
import { createApi } from "./api.js";
import { defaultGuilds, seedAll } from "./seed.js";

const ROOT = process.env.PLATFORM_ROOT ? resolve(process.env.PLATFORM_ROOT) : process.cwd();

// .env opcional, sem dependência: process.loadEnvFile existe desde Node 20.12
try { process.loadEnvFile(join(ROOT, ".env")); } catch { /* sem .env: segue com o ambiente */ }

export async function boot({ adapterKind = process.env.ADAPTER ?? "mock", port = Number(process.env.PORT ?? 4319), dbFile, quiet = false } = {}) {
  const file = dbFile ?? defaultDbPath();
  const store = createStore(file);
  const adapter = adapterKind === "discord"
    ? new DiscordAdapter({ token: process.env.DISCORD_TOKEN, appId: process.env.DISCORD_APP_ID })
    : new MockAdapter({ guilds: defaultGuilds(), verbose: !quiet });

  await adapter.start();

  // no Discord de verdade as guilds vêm do gateway; no mock, do seed
  const guilds = adapter.listGuilds?.().length ? adapter.listGuilds() : defaultGuilds();

  const core = {
    guilds,
    store,
    adapter,
    root: ROOT,

    async install({ dir, url, branch, installDir, build = false, guilds: targetGuilds = [guilds[0].id], caps, config = {} }) {
      const log = (l) => store.log({ level: "info", source: "build", message: l });

      // origem: link de repositório ou diretório local
      let src;
      let source = null;
      if (url && isRepoUrl(url)) {
        src = cloneRepo(url, { workDir: join(ROOT, ".plugins"), branch, onLog: log });
        source = { kind: "git", url, branch: branch ?? null, dir: src };
      } else {
        src = resolve(dir ?? installDir);
      }

      const pkg = loadLocalPackage(src, { store: ROOT, build, onLog: log });

      store.upsertPlugin({
        id: pkg.manifest.id,
        name: pkg.manifest.name,
        version: pkg.manifest.version,
        description: pkg.manifest.description,
        repoUrl: source?.url ?? pkg.repoUrl,
        branch: source?.branch ?? pkg.branch,
        commitSha: pkg.commitSha,
        lang: pkg.lang,
        runtime: pkg.runtime,
        manifest: pkg.manifest.raw,
      });

      // guarda de onde atualizar depois (botão "Atualizar" do painel)
      if (source) store.setSetting(`source:${pkg.manifest.id}`, source);

      const approved = caps ?? pkg.manifest.capabilities;
      for (const g of targetGuilds) store.installToGuild(pkg.manifest.id, g, approved, config);

      await router.reload();
      store.log({ pluginId: pkg.manifest.id, level: "info", source: "core", message: `instalado de ${src}` });

      // slash commands do Discord precisam refletir o que acabou de ser instalado
      await core.syncCommands().catch((err) => store.log({
        level: "warn", source: "core", message: `slash commands não sincronizados: ${err.message}`,
      }));

      return {
        id: pkg.manifest.id,
        name: pkg.manifest.name,
        version: pkg.manifest.version,
        lang: pkg.lang,
        commitSha: pkg.commitSha,
        capabilities: approved,
        commands: pkg.manifest.commands,
        source,
      };
    },

    /**
     * Puxa o último commit do repositório e recarrega o plugin em runtime:
     * manifesto novo, comandos novos, processo reiniciado e slash commands
     * re-registrados. Guilds, permissões e configuração são preservados.
     */
    async refresh(pluginId) {
      const existing = store.getPlugin(pluginId);
      if (!existing) {
        const err = new Error(`plugin "${pluginId}" não existe`);
        err.code = "E_NOT_FOUND";
        throw err;
      }
      const source = store.setting(`source:${pluginId}`, null);
      if (!source?.url) {
        return { ok: true, updated: false, reason: "plugin instalado de diretório local: nada a puxar", commitSha: existing.commitSha };
      }

      const log = (l) => store.log({ pluginId, level: "info", source: "build", message: l });
      const before = existing.commitSha;

      // garante o clone mesmo se o diretório foi apagado
      if (!existsSync(join(source.dir, "plugin.toml"))) {
        source.dir = cloneRepo(source.url, { workDir: join(ROOT, ".plugins"), branch: source.branch, onLog: log });
      } else {
        pullRepo(source.dir, { branch: source.branch, onLog: log });
      }

      const pkg = loadLocalPackage(source.dir, { store: ROOT, build: true, onLog: log });

      // preserva quem já tem o plugin instalado e o que o dono aprovou
      const installs = store.listGuildInstalls(pluginId);
      const guildIds = installs.map((i) => i.guildId);
      store.upsertPlugin({
        id: pkg.manifest.id,
        name: pkg.manifest.name,
        version: pkg.manifest.version,
        description: pkg.manifest.description,
        repoUrl: source.url,
        branch: source.branch ?? pkg.branch,
        commitSha: pkg.commitSha,
        lang: pkg.lang,
        runtime: pkg.runtime,
        manifest: pkg.manifest.raw,
        enabled: existing.enabled,
        status: existing.status,
      });
      for (const i of installs) store.installToGuild(pkg.manifest.id, i.guildId, i.caps, i.config);
      // mantém o clone como origem: é dele que o próximo refresh puxa
      store.setSetting(`source:${pluginId}`, source);

      // reinicia o processo: código do plugin mudou. Tira o host do mapa antes
      // de desligar para que o handler de exit do processo antigo não interfira.
      await router.unregister(pluginId, "atualizado pelo painel");
      await router.reload();
      await core.syncCommands().catch(() => {});

      const res = {
        ok: true,
        updated: before !== pkg.commitSha,
        id: pkg.manifest.id,
        version: pkg.manifest.version,
        commitShaBefore: before,
        commitSha: pkg.commitSha,
        commands: pkg.manifest.commands,
        guilds: guildIds,
        lang: pkg.lang,
      };
      store.log({
        pluginId, level: "info", source: "core",
        message: `atualizado ${before ?? "?"} → ${pkg.commitSha ?? "?"} (${pkg.manifest.commands.length} comandos)`,
      });
      return res;
    },

    /** comandos que o painel pode ligar/desligar e renomear (por plugin) */
    commandOverrides(pluginId) {
      return store.setting(`commands:${pluginId}`, null);
    },
    async setCommandOverrides(pluginId, list) {
      store.setSetting(`commands:${pluginId}`, list);
      await router.reload();
      await core.syncCommands().catch(() => {});
      return { ok: true, commands: list };
    },

    async conformance(dir) {
      const pkg = loadLocalPackage(resolve(dir), { build: false });
      return runConformance(pkg.dir, pkg.manifest);
    },

    /** registra no Discord os slash commands, por servidor */
    async syncCommands() {
      // cada guild recebe só os comandos dos plugins ativos instalados nela
      const byGuild = {};
      for (const g of guilds) byGuild[g.id] = [];
      for (const host of router.hosts.values()) {
        const p = host.plugin;
        if (!p.enabled) continue;
        for (const g of p.guilds) {
          if (!byGuild[g.id]) byGuild[g.id] = [];
          byGuild[g.id].push(...p.commands);
        }
      }
      for (const id of Object.keys(byGuild)) {
        byGuild[id] = [...new Map(byGuild[id].map((c) => [c.name, c])).values()];
      }
      return adapter.registerCommands?.(byGuild);
    },
  };

  const router = new Router({ store, adapter, log: () => {} });
  core.router = router;

  adapter.onEmit = async (kind, data) => {
    if (kind === "command" || kind === "message") {
      await router.dispatchCommand(data);
    } else if (kind === "event") {
      await router.dispatchEvent(data);
    }
  };

  await router.load();

  // slash commands: registra o que os plugins aprovados declararam
  try {
    const reg = await core.syncCommands();
    if (reg && !reg.skipped && !quiet) console.log(`slash commands registrados: ${reg.count}`);
  } catch (err) {
    console.error(`falha ao registrar slash commands: ${err.message}`);
  }

  const server = createApi({ store, router, adapter, core });
  const listen = () => new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(port, "127.0.0.1", () => res(server.address().port));
  });

  let actualPort = port;
  try { actualPort = await listen(); }
  catch (err) {
    if (err.code === "EADDRINUSE") { actualPort = await listen(); }
    else throw err;
  }

  return { store, router, adapter, core, guilds, server, port: actualPort, dbFile: file, close: async () => { await router.stopAll(); await adapter.stop?.(); server.close(); } };
}

/* ── CLI ── */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const seed = args.includes("--seed");
  const portArg = args.find((a) => a.startsWith("--port="));
  const app = await boot({ port: portArg ? Number(portArg.split("=")[1]) : undefined });

  if (seed) {
    const out = await seedAll(app);
    console.log(`\nseed: ${out.installed.length} plugins instalados`);
    for (const p of out.installed) console.log(`  · ${p.id} v${p.version} (${p.lang}) → ${out.guilds.join(", ")}`);
  }

  const active = app.store.listPlugins().filter((p) => p.enabled);
  console.log(`\n\x1b[1mplugin platform\x1b[0m  adapter=${app.adapter.kind}  port=${app.port}`);
  console.log(`painel: \x1b[36mhttp://127.0.0.1:${app.port}\x1b[0m`);
  console.log(`plugins: ${active.map((p) => p.id).join(", ") || "nenhum"}\n`);

  const shutdown = async () => { await app.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
