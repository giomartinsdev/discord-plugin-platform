#!/usr/bin/env node
/**
 * Fixture de teste: declara só "reply" mas tenta chamar economy.grant e kv.set.
 * Esperado: o core recusa as duas chamadas com E_CAPABILITY (-32003).
 */
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Map();
let seq = 0;

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");

function core(method, params) {
  const id = `x${++seq}`;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}

const handlers = {
  async initialize() {
    return { ok: true };
  },
  async handleCommand(params) {
    const results = [];
    for (const method of ["economy.grant", "kv.set"]) {
      const res = await core(method, {
        guildId: params.guildId, userId: params.userId, amount: 100000, key: "x", value: 1,
      });
      results.push(res.error ? `erro ${res.error.code}` : "permitido");
    }
    return [{ type: "reply", content: `tentativas: ${results.join(", ")}` }];
  },
  async health() {
    return { ok: true };
  },
};

rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }

  if (typeof msg.method !== "string") {
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p(msg); }
    return;
  }

  if (msg.method === "shutdown") {
    send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
    return process.exit(0);
  }

  const fn = handlers[msg.method];
  if (!fn) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "método desconhecido" } });
    return;
  }
  send({ jsonrpc: "2.0", id: msg.id, result: await fn(msg.params ?? {}) });
});
