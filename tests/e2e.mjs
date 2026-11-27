#!/usr/bin/env node
/**
 * E2E: sobe o core de verdade (SQLite em arquivo temporário, adapter mock),
 * instala os seis plugins, dispara comandos reais de cada um e verifica
 * as mensagens que sairiam no Discord.
 */
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` \x1b[2m${detail}\x1b[0m` : ""}`);
  } else {
    failed++;
    failures.push({ name, detail });
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` \x1b[2m${detail}\x1b[0m` : ""}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "bot-e2e-"));
  const dbFile = join(dir, "test.db");

  // PLATFORM_ROOT aponta para o repo para que .plugins/ caia no tmp
  process.env.PLATFORM_ROOT = dir;
  const { boot } = await import("../core/src/index.js");
  const { seedAll } = await import("../core/src/seed.js");

  const app = await boot({ dbFile, port: 0, quiet: true });
  const { store, router, adapter } = app;

  section("instalação");
  const seeded = await seedAll(app);
  check("6 plugins instalados", seeded.installed.length === 6, seeded.installed.map((p) => p.id).join(", "));
  check("banco registrou todos", store.listPlugins().length === 6);

  const langs = store.listPlugins().map((p) => p.lang).sort();
  check("4+ linguagens distintas", new Set(langs).size >= 4, langs.join(", "));

  section("adapter mock + roteamento");
  const run = async (command, args = [], userId = "4410", guildId = "1201") => {
    const before = adapter.messages.length;
    const res = await router.dispatchCommand({
      command, args, guildId, userId, channelId: "c1", messageId: `m-${Date.now()}`, isInteraction: false,
    });
    const msg = adapter.messages[before];
    return { res, text: msg?.content ?? null, ok: res.handled };
  };

  /* ── economia ── */
  section("economia (JavaScript)");
  let r = await run("saldo");
  check("!saldo responde", r.ok && /moedas/.test(r.text ?? ""), trunc(r.text));
  check("!saldo mostra saldo semeado", /1\.240/.test(r.text ?? ""), trunc(r.text));

  r = await run("daily");
  check("!daily entrega recompensa", r.ok && /recompensa diária/i.test(r.text ?? ""), trunc(r.text));
  const afterDaily = store.econGet("1201", "4410");
  check("!daily creditou moedas", afterDaily > 1240, `saldo ${afterDaily}`);

  r = await run("daily");
  check("!daily bloqueia segundo resgate", /já resgatou/i.test(r.text ?? ""), trunc(r.text));

  const pagarBefore = store.econGet("1201", "8891");
  r = await run("pagar", ["<@8891>", "100"]);
  check("!pagar transfere", r.ok && /pagou/i.test(r.text ?? ""), trunc(r.text));
  check("!pagar creditou destino", store.econGet("1201", "8891") === pagarBefore + 100);

  r = await run("pagar", ["<@8891>", "999999"]);
  check("!pagar recusa saldo insuficiente", /insuficiente/i.test(r.text ?? ""), trunc(r.text));

  r = await run("pagar", ["<@4410>", "10"]);
  check("!pagar recusa auto-transferência", /si mesmo/i.test(r.text ?? ""));

  /* ── pets ── */
  section("pets (Python)");
  r = await run("pet", [], "7001");
  check("!pet adota na primeira vez", r.ok && /adotou/i.test(r.text ?? ""), trunc(r.text));
  check("!pet gravou no kv", store.kvGet("pets", "1201", "pet:7001") !== undefined);
  r = await run("pet", [], "7001");
  check("!pet respeita cooldown", /descansando|fome/i.test(r.text ?? ""), trunc(r.text));
  r = await run("petrank");
  check("!petrank lista pets", r.ok && /Ranking de pets/i.test(r.text ?? ""), trunc(r.text));

  /* ── loja ── */
  section("loja (Go)");
  r = await run("loja");
  check("!loja lista itens", r.ok && /Cargo VIP/.test(r.text ?? ""), trunc(r.text));
  const lojaBefore = store.econGet("1201", "8891");
  check("saldo suficiente para comprar", lojaBefore >= 400, `saldo ${lojaBefore}`);
  r = await run("comprar", ["coruja"], "8891");
  check("!comprar cobra e entrega", r.ok && /Comprou/i.test(r.text ?? ""), trunc(r.text));
  check("!comprar debitou moedas", store.econGet("1201", "8891") < lojaBefore);
  check("!comprar deu cargo (addRole)", adapter.roles.some((x) => x.userId === "8891" && x.op === "add"));
  r = await run("comprar", ["coruja"], "8891");
  check("!comprar recusa item repetido", /já tem/i.test(r.text ?? ""), trunc(r.text));
  r = await run("inventario", [], "8891");
  check("!inventario lista compra", r.ok && /Cargo Coruja/.test(r.text ?? ""), trunc(r.text));
  r = await run("comprar", ["vip"], "2299");
  check("!comprar recusa sem saldo", /Faltam/i.test(r.text ?? ""), trunc(r.text));

  /* ── cassino ── */
  section("cassino (TypeScript/bun)");
  r = await run("roleta", ["vermelho", "50"], "3320");
  check("!roleta responde", r.ok && /Deu \*\*\d+/.test(r.text ?? ""), trunc(r.text));
  r = await run("roleta", ["vermelho", "1"], "3320");
  check("!roleta recusa aposta abaixo do mínimo", /mínima/i.test(r.text ?? ""), trunc(r.text));
  r = await run("roleta", ["roxo", "50"], "3320");
  check("!roleta recusa cor inválida", /Escolha/i.test(r.text ?? ""));
  r = await run("caraoucoroa", ["cara", "30"], "3320");
  check("!caraoucoroa responde", r.ok && /Deu \*\*(cara|coroa)\*\*/.test(r.text ?? ""), trunc(r.text));
  r = await run("apostas", [], "3320");
  check("!apostas acumula estatística", r.ok && /apostas/.test(r.text ?? ""), trunc(r.text));
  check("!apostas persistiu no kv", store.kvGet("cassino", "1201", "stats:3320")?.bets >= 2);

  // emit só passa com a capability aprovada
  const warns = store.logs({ limit: 300 }).filter((l) => l.source === "capability" && l.pluginId === "cassino");
  check("emit do cassino autorizado", warns.length === 0, warns.map((w) => w.message).join("; "));

  /* ── moderação ── */
  section("moderacao (Ruby)");
  r = await run("aviso", ["<@6001>", "spam"], "4410");
  check("!aviso registra", r.ok && /recebeu um aviso \(1\/3\)/.test(r.text ?? ""), trunc(r.text));
  await run("aviso", ["<@6001>", "spam de novo"], "4410");
  r = await run("aviso", ["<@6001>", "terceira"], "4410");
  check("!aviso aplica punição no limite", /Limite atingido/i.test(r.text ?? ""), trunc(r.text));
  check("!aviso deu cargo de silenciado", adapter.roles.some((x) => x.userId === "6001" && x.roleId === "9100"));
  r = await run("historico", ["<@6001>"], "4410");
  check("!historico lista punições", r.ok && /Histórico/.test(r.text ?? ""), trunc(r.text));
  r = await run("banir", ["<@6002>", "raid"], "4410");
  check("!banir expulsa", r.ok && /removido/i.test(r.text ?? ""), trunc(r.text));
  check("!banir chamou kick", adapter.kicks.some((k) => k.userId === "6002"));
  r = await run("banir", ["<@4410>"], "4410");
  check("!banir recusa auto-ban", /si mesmo/i.test(r.text ?? ""));

  /* ── ranking ── */
  section("ranking (Java)");
  r = await run("top");
  check("!top ordena fortunas", r.ok && /Maiores fortunas/i.test(r.text ?? ""), trunc(r.text));
  check("!top começa pelo maior saldo", (r.text ?? "").indexOf("<@4410>") < (r.text ?? "").indexOf("<@2299>"), trunc(r.text));
  r = await run("meu-top", [], "7712");
  check("!meu-top acha posição", r.ok && /º lugar/.test(r.text ?? ""), trunc(r.text));
  r = await run("meu-top", [], "9999");
  check("!meu-top fora do ranking", /não aparece/i.test(r.text ?? ""));

  /* ── capacidades ── */
  section("fronteira de segurança");

  // plugin que declara só `reply` e tenta escalar privilégio
  const intruderDir = join(ROOT, "tests", "fixtures", "intruso");
  await app.core.install({ dir: intruderDir, guilds: ["1201"] });
  const before = adapter.messages.length;
  const intrusion = await router.dispatchCommand({
    command: "tentar", args: [], guildId: "1201", userId: "4410",
    channelId: "c1", messageId: "m-intruso", isInteraction: false,
  });
  const intrusionText = adapter.messages[before]?.content ?? "";
  check("plugin intruso foi executado", intrusion.handled === true, trunc(intrusionText));
  check("chamada economy.grant negada", /erro -32003/.test(intrusionText));
  check("chamada kv.set negada", (intrusionText.match(/erro -32003/g) ?? []).length === 2, intrusionText);
  check("nenhuma moeda foi concedida", store.econGet("1201", "4410") < 2000, `saldo ${store.econGet("1201", "4410")}`);
  check("negativa registrada no log de capability",
    store.logs({ limit: 200 }).some((l) => l.source === "capability" && l.pluginId === "intruso"));

  // remove o fixture para não afetar contagens adiante
  await router.host("intruso")?.shutdown("fixture");
  store.deletePlugin("intruso");
  await router.reload();
  check("fixture removido", store.getPlugin("intruso") === null);

  const rankHost = router.host("ranking");
  // action fora do escopo
  const fakeHost = router.host("ranking");
  const bad = router.validateAction(fakeHost, { type: "kick", userId: "1" }, { guildId: "1201" });
  check("action kick negada ao ranking", bad.ok === false && /kick/.test(bad.reason), bad.reason);

  const noType = router.validateAction(fakeHost, { content: "oi" }, { guildId: "1201" });
  check("action sem type é recusada", noType.ok === false);

  const wrongGuild = router.validateAction(fakeHost, { type: "reply", content: "oi" }, { guildId: "9999" });
  check("action fora da guild é recusada", wrongGuild.ok === false, wrongGuild.reason);

  /* ── observabilidade ── */
  section("observabilidade");
  const logs = store.logs({ limit: 200 });
  check("logs gravados", logs.length > 0, `${logs.length} linhas`);
  const stats = store.pluginStats("ranking");
  check("estatísticas de chamada gravadas", stats.calls > 0, `${stats.calls} chamadas`);

  /* ── API HTTP ── */
  section("API HTTP");
  const base = `http://127.0.0.1:${app.port}`;
  const get = async (p) => (await fetch(base + p)).json();

  const status = await get("/api/status");
  check("GET /api/status", status.plugins.total === 6, `${status.plugins.active} ativos`);
  check("/api/status traz volume", Array.isArray(status.volume) && status.volume.length === 24);

  const plugins = await get("/api/plugins");
  check("GET /api/plugins", Array.isArray(plugins) && plugins.length === 6);
  check("/api/plugins traz capacidades", plugins.every((p) => Array.isArray(p.capabilities)));

  const one = await get("/api/plugins/loja");
  check("GET /api/plugins/loja", one.id === "loja" && one.lang === "go");
  check("plugin detail traz comandos", one.commands.some((c) => c.name === "comprar"));

  const guilds = await get("/api/guilds");
  check("GET /api/guilds", Array.isArray(guilds) && guilds.length >= 3);
  check("guild traz plugins instalados", guilds[0].plugins.length > 0);

  const logsApi = await get("/api/logs?limit=10");
  check("GET /api/logs", Array.isArray(logsApi) && logsApi.length > 0);

  const econ = await get("/api/economy/1201");
  check("GET /api/economy", Array.isArray(econ.top) && econ.top.length > 0);

  const sim = await (await fetch(base + "/api/simulate/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "loja", guildId: "1201" }),
  })).json();
  check("POST /api/simulate/command", sim.handled === true);

  const health = await get("/api/health");
  check("GET /api/health", Array.isArray(health) && health.length === 6);
  check("health vê todos vivos", health.every((h) => h.alive || h.stats.calls === 0), health.map((h) => `${h.id}:${h.alive}`).join(" "));

  const missing = await fetch(base + "/api/plugins/naoexiste");
  check("API 404 em plugin inexistente", missing.status === 404);

  /* ── conformidade via API ── */
  section("conformidade via API");
  const conf = await (await fetch(base + "/api/conformance", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir: join(ROOT, "plugins", "pets") }),
  })).json();
  check("/api/conformance aprova pets", conf.ok === true, `${conf.results?.filter((r) => r.ok).length}/${conf.results?.length} checagens`);

  /* ── painel estático ── */
  const html = await (await fetch(base + "/")).text();
  check("painel é servido em /", html.includes("<!doctype html") || html.includes("<!DOCTYPE html"));

  /* guia de criação de plugin dentro do painel, nos dois modos */
  check("painel tem o guia de plugin", html.includes('data-go="guide"') && html.includes("function viewGuide"));
  check("guia tem modo humano e modo IA", html.includes("guideForHuman") && html.includes("guideForAI"));
  check("guia cita o teste de conformidade", html.includes("conformance") && html.includes("plugin.toml"));

  await app.close();
  rmSync(dir, { recursive: true, force: true });

  console.log("");
  if (failed) {
    console.log(`\x1b[31m${failed} falha(s)\x1b[0m, ${passed} passaram`);
    for (const f of failures) console.log(`  - ${f.name} ${f.detail}`);
    process.exit(1);
  }
  console.log(`\x1b[32m${passed} verificações passaram\x1b[0m`);
}

const trunc = (s) => (s ? `"${s.replace(/\n/g, " ⏎ ").slice(0, 72)}${s.length > 72 ? "…" : ""}"` : "(sem mensagem)");

main().catch((err) => {
  console.error("\x1b[31merro fatal:\x1b[0m", err);
  process.exit(1);
});
