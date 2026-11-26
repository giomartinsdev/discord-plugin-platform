import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../core/src/db.js";
import { Router, parseDuration } from "../core/src/router.js";
import { MockAdapter } from "../core/src/adapters/mock.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "router-"));
  const store = createStore(join(dir, "t.db"));
  const adapter = new MockAdapter({ verbose: false });
  const router = new Router({ store, adapter });
  return {
    store, adapter, router,
    done: () => { rmSync(dir, { recursive: true, force: true }); },
  };
}

const plugin = (id, commands, capabilities = ["reply"]) => ({
  id, name: id, version: "1.0.0", description: "", lang: "javascript",
  runtime: { kind: "process", cmd: ["node", "-e", ""], timeoutMs: 1000 },
  manifest: { capabilities, commands: commands.map((name) => ({ name })), events: [] },
  status: "healthy", enabled: true, restarts: 0,
});

const install = (store, id) => store.installToGuild(id, "1201", store.getPlugin(id).manifest.capabilities, {});

test("parseDuration converte unidades", () => {
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration("2s"), 2000);
  assert.equal(parseDuration("3m"), 180000);
  assert.equal(parseDuration("1h"), 3600000);
  assert.equal(parseDuration("1d"), 86400000);
  assert.throws(() => parseDuration("amanhã"), /duração inválida/);
});

test("dispatchCommand ignora comando de plugin não instalado na guild", async () => {
  const { store, router, done } = fresh();
  store.upsertPlugin(plugin("a", ["ping"]));
  await router.reload();

  const out = await router.dispatchCommand({
    command: "ping", guildId: "9999", userId: "1", channelId: "1",
  });
  assert.equal(out.handled, false);
  assert.match(out.reason, /não registrado/);
  done();
});

test("dispatchCommand ignora comando que nenhum plugin declara", async () => {
  const { store, router, done } = fresh();
  store.upsertPlugin(plugin("a", ["ping"]));
  install(store, "a");
  await router.reload();

  const out = await router.dispatchCommand({
    command: "voar", guildId: "1201", userId: "1", channelId: "1",
  });
  assert.equal(out.handled, false);
  done();
});

test("validateAction recusa action de outra guild", () => {
  const { store, router, done } = fresh();
  store.upsertPlugin(plugin("a", ["ping"]));
  install(store, "a");
  router.register(store.getPlugin("a"), [{ id: "1201", config: {}, caps: ["reply"] }], ["reply"]);

  const host = router.host("a");
  assert.equal(router.validateAction(host, { type: "reply", content: "oi" }, { guildId: "1201" }).ok, true);
  assert.equal(router.validateAction(host, { type: "reply", content: "oi" }, { guildId: "1202" }).ok, false);
  done();
});

test("validateAction recusa capability não aprovada", () => {
  const { store, router, done } = fresh();
  store.upsertPlugin(plugin("a", ["ping"]));
  install(store, "a");
  router.register(store.getPlugin("a"), [{ id: "1201", config: {}, caps: ["reply"] }], ["reply"]);

  const host = router.host("a");
  const r = router.validateAction(host, { type: "kick", userId: "1" }, { guildId: "1201" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /"kick" não aprovada/);
  done();
});

test("validateAction trunca conteúdo acima de 2000 caracteres", () => {
  const { store, router, done } = fresh();
  store.upsertPlugin(plugin("a", ["ping"]));
  install(store, "a");
  router.register(store.getPlugin("a"), [{ id: "1201", config: {}, caps: ["reply"] }], ["reply"]);

  const host = router.host("a");
  const action = { type: "reply", content: "x".repeat(3000) };
  assert.equal(router.validateAction(host, action, { guildId: "1201" }).ok, true);
  assert.equal(action.content.length, 2000);
  done();
});

test("validateAction recusa reply vazio e tipo desconhecido", () => {
  const { store, router, done } = fresh();
  store.upsertPlugin(plugin("a", ["ping"]));
  install(store, "a");
  router.register(store.getPlugin("a"), [{ id: "1201", config: {}, caps: ["reply"] }], ["reply"]);

  const host = router.host("a");
  assert.equal(router.validateAction(host, { type: "reply", content: "   " }, { guildId: "1201" }).ok, false);
  assert.equal(router.validateAction(host, { type: "nuke" }, { guildId: "1201" }).ok, false);
  assert.equal(router.validateAction(host, { content: "oi" }, { guildId: "1201" }).ok, false);
  done();
});

test("economia soma e ordena por guild", () => {
  const { store, done } = fresh();
  store.econGrant("1201", "1", 100);
  store.econGrant("1201", "1", 50);
  store.econGrant("1201", "2", 40);
  store.econGrant("1202", "3", 999);

  assert.equal(store.econGet("1201", "1"), 150);
  const top = store.econTop("1201", 10);
  assert.deepEqual(top.map((t) => t.userId), ["1", "2"]);
  assert.equal(store.econGet("1201", "3"), 0, "guild não vaza saldo");
  done();
});

test("economia aceita valor negativo (débito)", () => {
  const { store, done } = fresh();
  store.econGrant("1201", "1", 500);
  store.econGrant("1201", "1", -200);
  assert.equal(store.econGet("1201", "1"), 300);
  done();
});

test("kv isola plugins e guilds", () => {
  const { store, done } = fresh();
  store.kvSet("pets", "1201", "pet:1", { name: "Bilu" });
  store.kvSet("pets", "1202", "pet:1", { name: "Mimi" });
  store.kvSet("loja", "1201", "pet:1", "outro");

  assert.equal(store.kvGet("pets", "1201", "pet:1").name, "Bilu");
  assert.equal(store.kvGet("pets", "1202", "pet:1").name, "Mimi");
  assert.equal(store.kvGet("loja", "1201", "pet:1"), "outro");
  assert.equal(store.kvGet("pets", "1201", "inexistente"), undefined);
  done();
});

test("kv.keys filtra por prefixo", () => {
  const { store, done } = fresh();
  store.kvSet("pets", "1201", "pet:1", 1);
  store.kvSet("pets", "1201", "pet:2", 2);
  store.kvSet("pets", "1201", "outra", 3);

  assert.deepEqual(store.kvKeys("pets", "1201", "pet:"), ["pet:1", "pet:2"]);
  assert.equal(store.kvKeys("pets", "1201").length, 3);
  done();
});

test("kv del devolve se removeu", () => {
  const { store, done } = fresh();
  store.kvSet("pets", "1201", "k", 1);
  assert.equal(store.kvDel("pets", "1201", "k"), true);
  assert.equal(store.kvDel("pets", "1201", "k"), false);
  done();
});

test("remover plugin limpa kv e instalações", () => {
  const { store, done } = fresh();
  store.upsertPlugin(plugin("a", ["ping"]));
  install(store, "a");
  store.kvSet("a", "1201", "k", 1);

  store.deletePlugin("a");
  assert.equal(store.getPlugin("a"), null);
  assert.equal(store.listGuildInstalls("a").length, 0);
  assert.equal(store.kvGet("a", "1201", "k"), undefined);
  done();
});

test("logs guardam nível, origem e correlação", () => {
  const { store, done } = fresh();
  store.log({ pluginId: "pets", guildId: "1201", level: "warn", source: "capability", message: "negado", requestId: "abc123" });
  const [row] = store.logs({ limit: 5 });
  assert.equal(row.level, "warn");
  assert.equal(row.source, "capability");
  assert.equal(row.requestId, "abc123");
  done();
});

test("logs filtram por plugin", () => {
  const { store, done } = fresh();
  store.log({ pluginId: "a", level: "info", source: "core", message: "um" });
  store.log({ pluginId: "b", level: "info", source: "core", message: "dois" });

  const rows = store.logs({ pluginId: "a", limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message, "um");
  done();
});

test("pluginStats calcula calls, erros e p95", () => {
  const { store, done } = fresh();
  for (const ms of [10, 20, 30, 40, 100]) store.stat("a", "handleCommand", true, ms);
  store.stat("a", "handleCommand", false, 50, "boom");

  const s = store.pluginStats("a");
  assert.equal(s.calls, 6);
  assert.equal(s.errors, 1);
  assert.ok(s.p95 >= 50);
  done();
});
