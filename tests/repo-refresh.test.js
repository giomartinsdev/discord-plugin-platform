import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { boot } from "../core/src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

const MANIFEST = (name, version = "1.0.0") => `
name = "${name}"
display_name = "${name}"
version = "${version}"
lang = "javascript"
capabilities = ["reply"]

[runtime]
cmd = ["node", "main.js"]

[[commands]]
name = "ping"
description = "responde pong"
`;

const MAIN = (tag) => `
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  let result = {};
  if (req.method === "initialize") result = { ok: true };
  else if (req.method === "health") result = { ok: true };
  else if (req.method === "handleCommand") result = [{ type: "reply", content: "${tag}" }];
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\\n");
});
`;

/** Repositório git descartável com um plugin mínimo. */
function makeRepo(name, tag = "v1") {
  const dir = mkdtempSync(join(tmpdir(), "plugin-repo-"));
  writeFileSync(join(dir, "plugin.toml"), MANIFEST(name));
  writeFileSync(join(dir, "main.js"), MAIN(tag));
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "inicial");
  return {
    dir,
    sha: () => git("rev-parse", "--short", "HEAD").trim(),
    commit(message, { tag, extraCommand } = {}) {
      if (tag) writeFileSync(join(dir, "main.js"), MAIN(tag));
      if (extraCommand) {
        appendFileSync(join(dir, "plugin.toml"),
          `\n[[commands]]\nname = "${extraCommand}"\ndescription = "novo"\n`);
      }
      git("add", "-A");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message);
      return this.sha();
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function startApp() {
  const db = mkdtempSync(join(tmpdir(), "platform-db-"));
  const app = await boot({ adapterKind: "mock", port: 0, dbFile: join(db, "p.db"), quiet: true });
  const call = async (path, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${app.port}/api${path}`, {
      headers: { "content-type": "application/json" }, ...opts,
    });
    return { status: res.status, data: await res.json() };
  };
  return {
    app, call,
    close: async () => { await app.close(); rmSync(db, { recursive: true, force: true }); },
  };
}

const run = (call, command) => call("/simulate/command", {
  method: "POST",
  body: JSON.stringify({ command, guildId: app0Guild, userId: "1" }),
});
const app0Guild = "1201";

test("inspect aceita URL de repositório sem instalar", async () => {
  const repo = makeRepo("inspectme");
  const { call, close } = await startApp();
  try {
    const { status, data } = await call("/inspect", { method: "POST", body: JSON.stringify({ url: `file://${repo.dir}` }) });
    assert.equal(status, 200);
    assert.equal(data.id, "inspectme");
    assert.equal(data.fromRepo, true);
    assert.equal(data.commitSha, repo.sha());
    assert.deepEqual(data.commands.map((c) => c.name), ["ping"]);
    const list = await call("/plugins");
    assert.equal(list.data.length, 0, "inspecionar não instala");
  } finally { await close(); repo.cleanup(); }
});

test("inspect recusa origem que não é repositório", async () => {
  const { call, close } = await startApp();
  try {
    const { status, data } = await call("/inspect", { method: "POST", body: JSON.stringify({ url: "isso-nao-e-um-repo" }) });
    assert.equal(status, 400);
    assert.match(data.error, /repositório git/);
  } finally { await close(); }
});

test("instala de uma URL de repositório e roda o comando", async () => {
  const repo = makeRepo("fromrepo", "ola v1");
  const { call, close } = await startApp();
  try {
    const { status, data } = await call("/plugins", {
      method: "POST",
      body: JSON.stringify({ url: `file://${repo.dir}`, guilds: [app0Guild] }),
    });
    assert.equal(status, 201);
    assert.equal(data.id, "fromrepo");
    assert.equal(data.commitSha, repo.sha());
    assert.equal(data.source.url, `file://${repo.dir}`);

    const res = await call("/simulate/command", {
      method: "POST", body: JSON.stringify({ command: "ping", guildId: app0Guild, userId: "1" }),
    });
    assert.equal(res.data.results[0].executed[0].action.content, "ola v1");
  } finally { await close(); repo.cleanup(); }
});

test("refresh puxa commit novo e recarrega o código em runtime", async () => {
  const repo = makeRepo("refreshme", "antes");
  const { call, close } = await startApp();
  try {
    await call("/plugins", { method: "POST", body: JSON.stringify({ url: `file://${repo.dir}`, guilds: [app0Guild] }) });
    const antes = await call("/simulate/command", { method: "POST", body: JSON.stringify({ command: "ping", guildId: app0Guild, userId: "1" }) });
    assert.equal(antes.data.results[0].executed[0].action.content, "antes");

    const novo = repo.commit("muda a resposta", { tag: "depois" });
    const { status, data } = await call("/plugins/refreshme/refresh", { method: "POST", body: "{}" });
    assert.equal(status, 200);
    assert.equal(data.updated, true);
    assert.equal(data.commitSha, novo);
    assert.notEqual(data.commitShaBefore, novo);

    // o processo do plugin foi trocado: a resposta tem que ser a nova
    const depois = await call("/simulate/command", { method: "POST", body: JSON.stringify({ command: "ping", guildId: app0Guild, userId: "1" }) });
    assert.equal(depois.data.handled, true, JSON.stringify(depois.data));
    assert.equal(depois.data.results[0].executed[0].action.content, "depois");
  } finally { await close(); repo.cleanup(); }
});

test("refresh expõe comandos novos declarados no commit", async () => {
  const repo = makeRepo("newcmds");
  const { call, close } = await startApp();
  try {
    await call("/plugins", { method: "POST", body: JSON.stringify({ url: `file://${repo.dir}`, guilds: [app0Guild] }) });
    const antes = await call("/simulate/command", { method: "POST", body: JSON.stringify({ command: "novo", guildId: app0Guild, userId: "1" }) });
    assert.equal(antes.data.handled, false);

    repo.commit("novo comando", { extraCommand: "novo" });
    const { data } = await call("/plugins/newcmds/refresh", { method: "POST", body: "{}" });
    assert.deepEqual(data.commands.map((c) => c.name).sort(), ["novo", "ping"]);

    const depois = await call("/simulate/command", { method: "POST", body: JSON.stringify({ command: "novo", guildId: app0Guild, userId: "1" }) });
    assert.equal(depois.data.handled, true);
  } finally { await close(); repo.cleanup(); }
});

test("refresh repetido continua puxando do clone, não da cópia instalada", async () => {
  const repo = makeRepo("twice", "primeira");
  const { call, close } = await startApp();
  try {
    await call("/plugins", { method: "POST", body: JSON.stringify({ url: `file://${repo.dir}`, guilds: [app0Guild] }) });

    repo.commit("segunda", { tag: "segunda" });
    const first = await call("/plugins/twice/refresh", { method: "POST", body: "{}" });
    assert.equal(first.status, 200, JSON.stringify(first.data));

    repo.commit("terceira", { tag: "terceira" });
    const second = await call("/plugins/twice/refresh", { method: "POST", body: "{}" });
    assert.equal(second.status, 200, JSON.stringify(second.data));
    assert.equal(second.data.commitSha, repo.sha());

    const res = await call("/simulate/command", { method: "POST", body: JSON.stringify({ command: "ping", guildId: app0Guild, userId: "1" }) });
    assert.equal(res.data.results[0].executed[0].action.content, "terceira");
  } finally { await close(); repo.cleanup(); }
});

test("refresh preserva guilds, permissões e configuração", async () => {
  const repo = makeRepo("keepme");
  const { call, close } = await startApp();
  try {
    await call("/plugins", { method: "POST", body: JSON.stringify({ url: `file://${repo.dir}`, guilds: [app0Guild], caps: ["reply"], config: { tom: "calmo" } }) });
    repo.commit("sem mudança de manifesto", { tag: "v2" });
    const { data } = await call("/plugins/keepme/refresh", { method: "POST", body: "{}" });
    assert.deepEqual(data.guilds, [app0Guild]);

    const list = await call("/plugins");
    const p = list.data.find((x) => x.id === "keepme");
    assert.deepEqual(p.capabilities, ["reply"]);
    assert.equal(p.guilds[0].config.tom, "calmo");
    assert.equal(p.guilds[0].enabled, true);
  } finally { await close(); repo.cleanup(); }
});

test("refresh sem repositório responde sem erro", async () => {
  const repo = makeRepo("localonly");
  const { call, close } = await startApp();
  try {
    await call("/plugins", { method: "POST", body: JSON.stringify({ dir: repo.dir, guilds: [app0Guild] }) });
    const { status, data } = await call("/plugins/localonly/refresh", { method: "POST", body: "{}" });
    assert.equal(status, 200);
    assert.equal(data.updated, false);
    assert.match(data.reason, /diretório local/);
  } finally { await close(); repo.cleanup(); }
});

test("painel pode desligar um comando, e ele para de responder", async () => {
  const repo = makeRepo("toggleme");
  const { call, close } = await startApp();
  try {
    await call("/plugins", { method: "POST", body: JSON.stringify({ url: `file://${repo.dir}`, guilds: [app0Guild] }) });
    repo.commit("adiciona segundo comando", { extraCommand: "extra" });
    await call("/plugins/toggleme/refresh", { method: "POST", body: "{}" });

    const on = await call("/simulate/command", { method: "POST", body: JSON.stringify({ command: "extra", guildId: app0Guild, userId: "1" }) });
    assert.equal(on.data.handled, true);

    const put = await call("/plugins/toggleme/commands", {
      method: "PUT",
      body: JSON.stringify({ commands: [{ name: "ping", enabled: true }, { name: "extra", enabled: false }] }),
    });
    assert.equal(put.status, 200);

    const off = await call("/simulate/command", { method: "POST", body: JSON.stringify({ command: "extra", guildId: app0Guild, userId: "1" }) });
    assert.equal(off.data.handled, false);
    const still = await call("/simulate/command", { method: "POST", body: JSON.stringify({ command: "ping", guildId: app0Guild, userId: "1" }) });
    assert.equal(still.data.handled, true);
  } finally { await close(); repo.cleanup(); }
});

test("apelido de comando roteia para o nome original do plugin", async () => {
  const repo = makeRepo("aliasme", "resposta do ping");
  const { call, close } = await startApp();
  try {
    await call("/plugins", { method: "POST", body: JSON.stringify({ url: `file://${repo.dir}`, guilds: [app0Guild] }) });
    await call("/plugins/aliasme/commands", {
      method: "PUT",
      body: JSON.stringify({ commands: [{ name: "ping", enabled: true, alias: "pong" }] }),
    });

    const viaAlias = await call("/simulate/command", { method: "POST", body: JSON.stringify({ command: "pong", guildId: app0Guild, userId: "1" }) });
    assert.equal(viaAlias.data.handled, true);
    assert.equal(viaAlias.data.results[0].executed[0].action.content, "resposta do ping");

    const original = await call("/simulate/command", { method: "POST", body: JSON.stringify({ command: "ping", guildId: app0Guild, userId: "1" }) });
    assert.equal(original.data.handled, false, "o nome original deixa de responder");

    const list = await call("/plugins");
    const p = list.data.find((x) => x.id === "aliasme");
    assert.deepEqual(p.commands.map((c) => c.name), ["pong"]);
    assert.equal(p.commands[0].original, "ping");
  } finally { await close(); repo.cleanup(); }
});

test("painel recusa apelido inválido e plugin sem comando ativo", async () => {
  const repo = makeRepo("validateme");
  const { call, close } = await startApp();
  try {
    await call("/plugins", { method: "POST", body: JSON.stringify({ url: `file://${repo.dir}`, guilds: [app0Guild] }) });

    const bad = await call("/plugins/validateme/commands", {
      method: "PUT", body: JSON.stringify({ commands: [{ name: "ping", alias: "Nome Com Espaco" }] }),
    });
    assert.equal(bad.status, 400);

    const empty = await call("/plugins/validateme/commands", {
      method: "PUT", body: JSON.stringify({ commands: [{ name: "ping", enabled: false }] }),
    });
    assert.equal(empty.status, 400);
    assert.match(empty.data.error, /pelo menos um comando ativo/);
  } finally { await close(); repo.cleanup(); }
});
