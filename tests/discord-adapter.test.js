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
  async put(route, { body }) { globalThis.__registered = { route, body }; return body; }
}
export const Routes = { applicationCommands: (id) => \`/applications/\${id}/commands\` };
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

test("registerCommands envia opções e o campo livre de argumentos", async () => {
  const { adapterClass, cleanup } = await loadWithStub();
  const a = new adapterClass({ token: "t", appId: "777" });
  await a.start();
  const res = await a.registerCommands([
    { name: "saldo", description: "Mostra saldo" },
    { name: "pagar", description: "paga", options: [{ type: 3, name: "alvo" }] },
  ]);
  assert.equal(res.count, 2);
  assert.equal(globalThis.__registered.route, "/applications/777/commands");
  const [saldo, pagar] = globalThis.__registered.body;
  assert.equal(saldo.options[0].name, "argumentos");
  assert.deepEqual(pagar.options, [{ type: 3, name: "alvo" }]);
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
