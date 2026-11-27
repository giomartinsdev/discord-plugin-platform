#!/usr/bin/env node
/**
 * CLI do core. Sem dependência: só `node:util`.
 *
 *   bot-platform serve [--port=4319]
 *   bot-platform install <dir|url> [--guild=1201] [--branch=main] [--build]
 *   bot-platform refresh <id>
 *   bot-platform conformance <dir>
 *   bot-platform simulate <plugin> <comando> [args...]
 *   bot-platform dev
 */
import { boot } from "./src/index.js";
import { readManifestFromDir, isRepoUrl } from "./src/loader.js";
import { runConformance } from "./src/conformance.js";
import { seedAll, defaultGuilds } from "./src/seed.js";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const [cmd = "serve", ...rest] = process.argv.slice(2);
const flags = Object.fromEntries(
  rest.filter((a) => a.startsWith("--")).map((a) => {
    const [k, v = "true"] = a.replace(/^--/, "").split("=");
    return [k, v];
  }),
);
const positional = rest.filter((a) => !a.startsWith("--"));

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  blue: (s) => `\x1b[36m${s}\x1b[0m`,
};

switch (cmd) {
  case "serve":
  case "dev": {
    const app = await bootOrDie({ port: flags.port ? Number(flags.port) : undefined });
    if (cmd === "dev" && !app.store.setting("seeded")) {
      const out = await seedAll(app);
      console.log(c.dim(`seed: ${out.installed.length} plugins instalados`));
    }
    banner(app);
    await hang(app);
    break;
  }

  case "seed": {
    const app = await bootOrDie({ port: flags.port ? Number(flags.port) : 0, quiet: true });
    const out = await seedAll(app);
    for (const p of out.installed) console.log(`  ${c.green("✓")} ${p.id} v${p.version} ${c.dim(`(${p.lang})`)}`);
    console.log(c.bold(`\n${out.installed.length} plugins instalados`));
    await app.close();
    break;
  }

  case "install": {
    const origin = positional[0];
    if (!origin) die("informe o diretório ou a URL do repositório: bot-platform install <dir|url>");
    const app = await bootOrDie({ port: flags.port ? Number(flags.port) : 0, quiet: true });
    const guilds = flags.guild ? String(flags.guild).split(",") : [app.guilds[0]?.id ?? defaultGuilds()[0].id];
    const res = isRepoUrl(origin)
      ? await app.core.install({ url: origin, branch: flags.branch, guilds, build: !!flags.build })
      : await app.core.install({ dir: resolve(origin), guilds, build: !!flags.build });
    console.log(`${c.green("✓")} ${res.id} v${res.version} ${c.dim(`(${res.lang})`)} → ${guilds.join(", ")}`);
    console.log(c.dim(`  comandos: ${res.commands.map((x) => "!" + x.name).join(", ") || "nenhum"}`));
    await app.close();
    break;
  }

  case "refresh": {
    const id = positional[0];
    if (!id) die("informe o id do plugin: bot-platform refresh <id>");
    const app = await bootOrDie({ port: flags.port ? Number(flags.port) : 0, quiet: true });
    const res = await app.core.refresh(id);
    if (!res.updated) console.log(c.dim(`  ${res.reason ?? "nada a atualizar"} (${res.commitSha ?? "—"})`));
    else console.log(`${c.green("✓")} ${id} ${c.dim(`${res.commitShaBefore ?? "?"} → ${res.commitSha}`)} · ${res.commands.length} comandos`);
    await app.close();
    break;
  }

  case "conformance": {
    const dir = positional[0];
    if (!dir) die("informe o diretório: bot-platform conformance <dir>");
    const manifest = readManifestFromDir(resolve(dir));
    console.log(c.bold(`conformidade · ${manifest.id} v${manifest.version}`));
    const res = await runConformance(resolve(dir), manifest, { onLog: (l) => console.log("  " + l) });
    console.log(res.ok ? c.green("\n✓ conforme") : c.red("\n✗ não conforme"));
    process.exit(res.ok ? 0 : 1);
    break;
  }

  case "simulate": {
    const [pluginId, command, ...args] = positional;
    if (!pluginId || !command) die("uso: bot-platform simulate <plugin> <comando> [args...]");
    const app = await bootOrDie({ port: flags.port ? Number(flags.port) : 0, quiet: true });
    const plugin = app.store.getPlugin(pluginId);
    if (!plugin) die(`plugin "${pluginId}" não instalado. Rode "bot-platform seed".`);
    const guildId = flags.guild ?? app.store.listGuildInstalls(pluginId)[0]?.guildId ?? defaultGuilds()[0].id;
    const res = await app.router.dispatchCommand({
      command, args, guildId,
      userId: flags.user ?? "4410", channelId: "1", isInteraction: false,
    });
    for (const r of res.results ?? []) {
      if (r.error) console.log(c.red(`erro: ${r.error}`));
      else console.log(c.dim(`[${pluginId}]`) + " " + r.actions + " ação(ões), " + r.durationMs + " ms");
    }
    await app.close();
    break;
  }

  case "help":
  case "--help":
  case "-h":
    usage();
    break;

  default:
    die(`comando desconhecido: ${cmd}`);
}

function banner(app) {
  const active = app.store.listPlugins().filter((p) => p.enabled);
  console.log("");
  console.log(c.bold("  plugin platform"));
  console.log(c.dim(`  adapter ${app.adapter.kind} · port ${app.port} · ${active.length} plugin(s)`));
  console.log(`  painel  ${c.blue(`http://127.0.0.1:${app.port}`)}`);
  console.log(c.dim(`  dados   ${app.dbFile}`));
  console.log("");
  if (active.length) console.log(c.dim(`  ${active.map((p) => p.id).join(" · ")}`));
  console.log("");
}

function hang(app) {
  return new Promise(() => {
    const stop = async () => {
      console.log(c.dim("\nencerrando…"));
      await app.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

function usage() {
  console.log(`
${c.bold("bot-platform")} — plataforma de plugins para Discord

  ${c.bold("serve")}                 sobe o core e o painel (porta 4319)
  ${c.bold("dev")}                   serve + seed automático
  ${c.bold("seed")}                  instala os plugins de exemplo
  ${c.bold("install")} <dir>         instala um plugin local
  ${c.bold("conformance")} <dir>     roda os testes de protocolo de um plugin
  ${c.bold("simulate")} <p> <cmd>    dispara um comando sem Discord
`);
}

function die(msg) {
  console.error(c.red("erro: ") + msg);
  process.exit(1);
}

/** boot com mensagens de erro legíveis para os problemas de configuração conhecidos */
async function bootOrDie(opts) {
  try {
    return await boot(opts);
  } catch (err) {
    if (err.code === "E_NO_TOKEN" || err.code === "E_NO_DISCORD_JS") {
      die(err.message);
    }
    throw err;
  }
}

if (!existsSync(new URL(".", import.meta.url).pathname)) die("core não encontrado");
