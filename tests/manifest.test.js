import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToml, normalizeManifest } from "../core/src/manifest.js";
import { readManifestFromDir } from "../core/src/loader.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("parseToml lê escalares, arrays e tabelas", () => {
  const out = parseToml(`
name = "pets"
version = "1.0.0"
enabled = true
count = 3
caps = ["reply", "kv"]

[runtime]
kind = "process"
cmd = ["python3", "main.py"]
timeout_ms = 3000
`);
  assert.equal(out.name, "pets");
  assert.equal(out.enabled, true);
  assert.equal(out.count, 3);
  assert.deepEqual(out.caps, ["reply", "kv"]);
  assert.deepEqual(out.runtime.cmd, ["python3", "main.py"]);
  assert.equal(out.runtime.timeout_ms, 3000);
});

test("parseToml lê array de tabelas", () => {
  const out = parseToml(`
[[commands]]
name = "pet"
description = "Adota"

[[commands]]
name = "petrank"
description = "Ranking"
`);
  assert.equal(out.commands.length, 2);
  assert.equal(out.commands[0].name, "pet");
  assert.equal(out.commands[1].name, "petrank");
});

test("parseToml ignora comentários fora de strings", () => {
  const out = parseToml(`
# comentário
name = "pets # não é comentário" # este é
`);
  assert.equal(out.name, "pets # não é comentário");
});

test("normalizeManifest rejeita manifesto inválido", () => {
  assert.throws(() => normalizeManifest({}), /"name" é obrigatório/);
  assert.throws(() => normalizeManifest({ name: "x", version: "1.0.0" }), /runtime\.cmd é obrigatório/);
  assert.throws(
    () => normalizeManifest({ name: "x", version: "1", runtime: { cmd: ["node"] } }),
    /semver/,
  );
});

test("normalizeManifest rejeita capability desconhecida", () => {
  assert.throws(
    () => normalizeManifest({
      name: "x", version: "1.0.0",
      capabilities: ["admin_total"],
      runtime: { cmd: ["node"] },
    }),
    /capability desconhecida/,
  );
});

test("normalizeManifest rejeita comando duplicado", () => {
  assert.throws(
    () => normalizeManifest({
      name: "x", version: "1.0.0",
      commands: [{ name: "a" }, { name: "a" }],
      runtime: { cmd: ["node"] },
    }),
    /comando duplicado/,
  );
});

test("normalizeManifest rejeita nome de comando inválido", () => {
  assert.throws(
    () => normalizeManifest({
      name: "x", version: "1.0.0",
      commands: [{ name: "Comando Com Espaço" }],
      runtime: { cmd: ["node"] },
    }),
    /comando inválido/,
  );
});

test("cada plugin do repo passa na validação", () => {
  for (const id of ["pets", "economia", "loja", "cassino", "moderacao", "ranking"]) {
    const m = readManifestFromDir(join(ROOT, "plugins", id));
    assert.equal(m.id, id, `${id}: nome do manifesto deve ser o id do diretório`);
    assert.ok(m.commands.length > 0, `${id}: precisa de pelo menos um comando`);
    assert.ok(m.runtime.cmd.length > 0, `${id}: runtime.cmd obrigatório`);
    assert.ok(m.capabilities.length > 0, `${id}: precisa declarar capabilities`);
  }
});

test("manifesto normaliza defaults de config", () => {
  const m = readManifestFromDir(join(ROOT, "plugins", "pets"));
  assert.equal(m.config.reward.default, 10);
  assert.equal(m.config.cooldown.default, 30);
});
