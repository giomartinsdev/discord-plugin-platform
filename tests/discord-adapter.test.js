import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Carrega o adapter com um `discord.js` falso no caminho de resolução.
 * Assim testamos a lógica sem token e sem rede.
 */
async function loadWithStub() {
  const dir = mkdtempSync(join(tmpdir(), "discord-stub-"));
  const pkg = join(dir, "node_modules", "discord.js");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({
    name: "discord.js", version: "0.0.0-stub", type: "module", exports: "./index.mjs",
  }));
  writeFileSync(join(pkg, "index.mjs"), `
const handlers = new Map();
export const Events = { ClientReady: "clientReady", MessageCreate: "messageCreate",
  InteractionCreate: "interactionCreate", GuildMemberAdd: "guildMemberAdd", Error: "error" };
export const GatewayIntentBits = { Guilds: 1, GuildMessages: 512, MessageContent: 32768, GuildMembers: 2 };
export class REST {
  constructor() {}
  setToken() { return this; }
  async put(route, { body }) {
    if (globalThis.__failGuild && route.includes("/guilds/" + globalThis.__failGuild + "/")) {
      throw new Error("Missing Permissions");
    }
    (globalThis.__registered ??= []).push({ route, body });
    return body;
  }
}
export const Routes = {
  applicationCommands: (id) => \`/applications/\${id}/commands\`,
  applicationGuildCommands: (id, guildId) => \`/applications/\${id}/guilds/\${guildId}/commands\`,
};
export class Client {
  constructor() {
    // o gateway pode entregar a guild antes do nome: é o bug que o REST cobre
    this.guilds = {
      cache: new Map([["999", { id: "999", name: undefined, memberCount: 7 }]]),
      async fetch() {
        return new Map([["999", { id: "999", name: "Servidor Real", memberCount: 7 }]]);
      },
    };
    this.user = { tag: "bot#0001" };
  }
  on(ev, fn) { handlers.set(ev, fn); return this; }
  once(ev, fn) { handlers.set(ev, fn); return this; }
  async login() { handlers.get("clientReady")?.({ user: this.user }); }
  async destroy() {}
}
export const __handlers = handlers;
`);

  // copia o adapter para o diretório do stub para que o import resolva
  const src = join(HERE, "..", "core", "src", "adapters", "discord.js");
  const { readFileSync } = await import("node:fs");
  writeFileSync(join(dir, "adapter.mjs"), readFileSync(src, "utf8"));

  const mod = await import(pathToFileURL(join(dir, "adapter.mjs")).href + `?t=${Date.now()}`);
  // sem query: precisa ser a MESMA instância que o adapter carregou via "discord.js"
  const stub = await import(pathToFileURL(join(pkg, "index.mjs")).href);
  return { adapterClass: mod.DiscordAdapter, handlers: stub.__handlers, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const fakeGuild = { id: "999", name: "Servidor Real", memberCount: 7 };

function interaction({ id, name, value, deferred = false, replied = false }) {
  const rec = { reply: null, editReply: null, followUp: null, deferred: false };
  const i = {
    id, guildId: "999", channelId: "c2", user: { id: "u1" }, commandName: name,
    options: { data: value === undefined ? [] : [{ name: "argumentos", value }] },
    isChatInputCommand: () => true,
    replied, deferred,
    async reply(o) { rec.reply = o; i.replied = true; },
    async editReply(o) { rec.editReply = o; },
    async followUp(o) { rec.followUp = o; },
    async deferReply() { rec.deferred = true; i.deferred = true; },
  };
  return { i, rec };
}

test("boot sem token falha com E_NO_TOKEN", async () => {
  const { adapterClass, cleanup } = await loadWithStub();
  const a = new adapterClass({ token: undefined, appId: "1" });
  await assert.rejects(() => a.start(), (err) => err.code === "E_NO_TOKEN");
  cleanup();
});

test("boot publica as guilds reais do gateway", async () => {
  const { adapterClass, cleanup } = await loadWithStub();
  const a = new adapterClass({ token: "t", appId: "1" });
  await a.start();
  assert.equal(a.listGuilds().length, 1);
  assert.equal(a.listGuilds()[0].id, "999");
  assert.equal(a.listGuilds()[0].name, "Servidor Real");
  assert.equal(a.listGuilds()[0].initials, "SE");
  cleanup();
});

test("registerCommands registra por servidor e limpa o registro global antigo", async () => {
  const { adapterClass, cleanup } = await loadWithStub();
  const a = new adapterClass({ token: "t", appId: "777" });
  await a.start();
  globalThis.__registered = [];

  const res = await a.registerCommands({
    "999": [
      { name: "saldo", description: "Mostra saldo" },
      { name: "pagar", description: "paga", options: [{ type: 3, name: "alvo" }] },
    ],
    "888": [{ name: "pet", description: "cuida do pet" }],
    "777": [],
  });

  assert.equal(res.count, 3);
  assert.equal(res.guilds, 3);
  assert.equal(res.clearedGlobal, true);

  const global = globalThis.__registered.find((r) => r.route === "/applications/777/commands");
  assert.deepEqual(global.body, [], "comandos globais precisam ser limpos");

  const nine = globalThis.__registered.find((r) => r.route === "/applications/777/guilds/999/commands");
  assert.equal(nine.body.length, 2);
  assert.equal(nine.body[0].options[0].name, "argumentos");
  assert.deepEqual(nine.body[1].options, [{ type: 3, name: "alvo" }]);

  const eight = globalThis.__registered.find((r) => r.route === "/applications/777/guilds/888/commands");
  assert.deepEqual(eight.body.map((c) => c.name), ["pet"]);

  const empty = globalThis.__registered.find((r) => r.route === "/applications/777/guilds/777/commands");
  assert.deepEqual(empty.body, [], "servidor sem comando fica limpo");

  cleanup();
});

test("falha em um servidor não impede registrar nos outros", async () => {
  const { adapterClass, cleanup } = await loadWithStub();
  const a = new adapterClass({ token: "t", appId: "777" });
  await a.start();
  globalThis.__registered = [];
  globalThis.__failGuild = "888";

  const res = await a.registerCommands({
    "999": [{ name: "saldo", description: "Mostra saldo" }],
    "888": [{ name: "pet", description: "cuida do pet" }],
  });

  assert.equal(res.count, 1);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].guildId, "888");
  assert.ok(globalThis.__registered.some((r) => r.route.includes("/guilds/999/")));
  globalThis.__failGuild = null;
  cleanup();
});

test("não reenvia comandos iguais ao Discord (evita o rate limit de bulk overwrite)", async () => {
  const { adapterClass, cleanup } = await loadWithStub();
  const a = new adapterClass({ token: "t", appId: "777" });
  await a.start();
  globalThis.__registered = [];

  const payload = { "999": [{ name: "saldo", description: "Mostra saldo" }] };
  const first = await a.registerCommands(payload);
  assert.equal(first.count, 1);
  assert.equal(first.unchanged, 0);
  const callsAfterFirst = globalThis.__registered.length;

  const second = await a.registerCommands(payload);
  assert.equal(second.count, 0);
  assert.equal(second.unchanged, 1);
  assert.equal(globalThis.__registered.length, callsAfterFirst, "nada novo foi enviado");

  // mudou a descrição: reenvia
  const third = await a.registerCommands({ "999": [{ name: "saldo", description: "Outra" }] });
  assert.equal(third.count, 1);
  assert.ok(globalThis.__registered.length > callsAfterFirst);
  cleanup();
});

test("servidor que saiu da lista tem os comandos limpos", async () => {
  const { adapterClass, cleanup } = await loadWithStub();
  const a = new adapterClass({ token: "t", appId: "777" });
  await a.start();
  globalThis.__registered = [];

  await a.registerCommands({ "999": [{ name: "saldo", description: "s" }], "888": [{ name: "pet", description: "p" }] });
  const before = globalThis.__registered.length;

  await a.registerCommands({ "999": [{ name: "saldo", description: "s" }] });
  const calls = globalThis.__registered.slice(before);
  const cleaned = calls.find((c) => c.route.includes("/guilds/888/"));
  assert.ok(cleaned, "precisa limpar o servidor que saiu");
  assert.deepEqual(cleaned.body, []);
  cleanup();
});

test("mensagem de texto vira comando, e de bot ou DM é ignorada", async () => {
  const { adapterClass, handlers, cleanup } = await loadWithStub();
  const a = new adapterClass({ token: "t", appId: "1" });
  const seen = [];
  a.onEmit = (kind, data) => seen.push({ kind, data });
  await a.start();

  handlers.get("messageCreate")({ author: { bot: false }, guildId: "999", channelId: "c1", content: "!pagar <@2> 50", id: "m1" });
  handlers.get("messageCreate")({ author: { bot: true }, guildId: "999", channelId: "c1", content: "!pagar", id: "m2" });
  handlers.get("messageCreate")({ author: { bot: false }, guildId: null, channelId: "c1", content: "!saldo", id: "m3" });
  handlers.get("messageCreate")({ author: { bot: false }, guildId: "999", channelId: "c1", content: "oi sem comando", id: "m4" });

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].data.args, ["<@2>", "50"]);
  assert.equal(seen[0].data.command, "pagar");
  assert.equal(seen[0].data.isInteraction, false);
  cleanup();
});

test("slash command separa o campo argumentos como o comando de texto", async () => {
  const { adapterClass, handlers, cleanup } = await loadWithStub();
  const a = new adapterClass({ token: "t", appId: "1" });
  const seen = [];
  a.onEmit = (kind, data) => seen.push(data);
  await a.start();

  const { i } = interaction({ id: "i1", name: "pagar", value: "<@2> 50" });
  handlers.get("interactionCreate")(i);
  assert.deepEqual(seen[0].args, ["<@2>", "50"]);
  assert.equal(seen[0].isInteraction, true);
  cleanup();
});

test("resposta rápida usa reply; após 2 s adia e usa editReply", async () => {
  const { adapterClass, handlers, cleanup } = await loadWithStub();
  const a = new adapterClass({ token: "t", appId: "1" });
  await a.start();

  const fast = interaction({ id: "i1", name: "saldo" });
  handlers.get("interactionCreate")(fast.i);
  await a.sendMessage({ channelId: "c2", content: "rápido", interactionId: "i1" });
  assert.deepEqual(fast.rec.reply, { content: "rápido", ephemeral: false });
  assert.equal(fast.rec.deferred, false, "resposta rápida não deve adiar");

  const slow = interaction({ id: "i2", name: "saldo" });
  handlers.get("interactionCreate")(slow.i);
  await new Promise((r) => setTimeout(r, 2200));
  assert.equal(slow.rec.deferred, true, "deve adiar antes dos 3 s do Discord");
  await a.sendMessage({ channelId: "c2", content: "devagar", interactionId: "i2" });
  assert.deepEqual(slow.rec.editReply, { content: "devagar" });
  assert.equal(a.interactionTimers.has("i2"), false, "o timer do adiamento é cancelado");
  cleanup();
});

test("ephemeral chega ao Discord", async () => {
  const { adapterClass, handlers, cleanup } = await loadWithStub();
  const a = new adapterClass({ token: "t", appId: "1" });
  await a.start();
  const { i, rec } = interaction({ id: "i1", name: "saldo" });
  handlers.get("interactionCreate")(i);
  await a.sendMessage({ channelId: "c2", content: "só você", ephemeral: true, interactionId: "i1" });
  assert.equal(rec.reply.ephemeral, true);
  cleanup();
});

test("guildMemberAdd vira evento GUILD_MEMBER_ADD", async () => {
  const { adapterClass, handlers, cleanup } = await loadWithStub();
  const a = new adapterClass({ token: "t", appId: "1" });
  const seen = [];
  a.onEmit = (kind, data) => seen.push({ kind, data });
  await a.start();
  handlers.get("guildMemberAdd")({ id: "u9", guild: { id: "999" }, user: { username: "neo" } });
  assert.equal(seen[0].kind, "event");
  assert.equal(seen[0].data.type, "GUILD_MEMBER_ADD");
  assert.equal(seen[0].data.payload.userId, "u9");
  cleanup();
});
