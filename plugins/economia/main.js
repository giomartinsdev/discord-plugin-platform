#!/usr/bin/env node
/**
 * Plugin de economia. Exemplo em JavaScript puro, sem dependência.
 *
 * Protocolo: JSON-RPC 2.0, uma mensagem por linha, em stdin/stdout.
 * O plugin nunca recebe token do Discord — só devolve Actions.
 */
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

let seq = 0;
const pending = new Map();
const configs = new Map();

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function core(method, params) {
  const id = `p${++seq}`;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const log = (message, level = "info") => process.stderr.write(`[${level}] ${message}\n`);

/* ── formatação ── */

const coins = (n) => `${Number(n).toLocaleString("pt-BR")} moedas`;

/* ── comandos ── */

async function saldo(args, userId, guildId) {
  const target = (args[0] ?? "").replace(/[<@!>]/g, "") || userId;
  const { balance } = await core("economy.get", { guildId, userId: target });
  if (target === userId) return [{ type: "reply", content: `Você tem **${coins(balance)}**.` }];
  return [{ type: "reply", content: `<@${target}> tem **${coins(balance)}**.` }];
}

async function daily(args, userId, guildId) {
  const cfg = configs.get(guildId) ?? {};
  const amount = cfg.daily_amount ?? 100;
  const cooldownMs = (cfg.daily_cooldown_hours ?? 22) * 3_600_000;

  const key = `daily:${userId}`;
  const { value: last } = await core("kv.get", { guildId, key });
  const now = Date.now();

  if (last && now - last < cooldownMs) {
    const left = cooldownMs - (now - last);
    const h = Math.floor(left / 3_600_000);
    const m = Math.ceil((left % 3_600_000) / 60_000);
    return [{ type: "reply", content: `Você já resgatou hoje. Volte em **${h}h ${m}min**.` }];
  }

  await core("kv.set", { guildId, key, value: now });
  const { balance } = await core("economy.grant", { guildId, userId, amount, reason: "daily" });

  return [
    { type: "reply", content: `+**${coins(amount)}** de recompensa diária. Saldo: **${coins(balance)}**.` },
    { type: "emit", topic: "economy.daily", payload: { userId, amount } },
  ];
}

async function pagar(args, userId, guildId) {
  const target = (args[0] ?? "").replace(/[<@!>]/g, "");
  const amount = Math.floor(Number(args[1]));

  if (!target) return [{ type: "reply", content: "Use `!pagar @alguém 100`." }];
  if (target === userId) return [{ type: "reply", content: "Não dá para pagar a si mesmo." }];
  if (!Number.isFinite(amount) || amount <= 0) return [{ type: "reply", content: "Informe um valor válido acima de zero." }];

  const { balance } = await core("economy.get", { guildId, userId });
  if (balance < amount) {
    return [{ type: "reply", content: `Saldo insuficiente. Você tem **${coins(balance)}**.` }];
  }

  const fee = Math.round((amount * (configs.get(guildId)?.transfer_fee ?? 0)) / 100);
  await core("economy.grant", { guildId, userId, amount: -amount, reason: `transferência para ${target}` });
  await core("economy.grant", { guildId, userId: target, amount: amount - fee, reason: `transferência de ${userId}` });

  const note = fee > 0 ? ` (taxa de ${fee})` : "";
  return [{
    type: "reply",
    content: `<@${userId}> pagou **${coins(amount)}** para <@${target}>${note}.`,
  }];
}

/* ── roteamento ── */

const COMMANDS = { saldo, daily, pagar };

async function handleCommand(params) {
  const fn = COMMANDS[params.command];
  if (!fn) return [{ type: "reply", content: `Comando \`${params.command}\` não existe aqui.` }];
  return fn(params.args ?? [], params.userId ?? "0", params.guildId ?? "0");
}

async function handleEvent() {
  return [];
}

async function onRequest(msg) {
  const { id, method, params = {} } = msg;
  const guildId = params.guildId ?? "0";

  try {
    switch (method) {
      case "initialize":
        for (const g of params.guilds ?? []) {
          const { config } = await core("config.get", { guildId: g.id });
          configs.set(g.id, config ?? {});
        }
        log(`inicializado para ${(params.guilds ?? []).length} servidor(es)`);
        return send({ jsonrpc: "2.0", id, result: { ok: true } });

      case "handleCommand":
        return send({ jsonrpc: "2.0", id, result: await handleCommand(params) });

      case "handleEvent":
        return send({ jsonrpc: "2.0", id, result: await handleEvent(params) });

      case "health":
        return send({ jsonrpc: "2.0", id, result: { ok: true, detail: "economia ativa" } });

      case "shutdown":
        send({ jsonrpc: "2.0", id, result: { ok: true } });
        return process.exit(0);

      default:
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `método desconhecido: ${method}` } });
    }
  } catch (err) {
    log(`erro em ${method}: ${err.message}`, "error");
    send({ jsonrpc: "2.0", id, error: { code: -32000, message: err.message } });
  }
}

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;

  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return log(`linha inválida: ${text.slice(0, 80)}`, "warn");
  }

  if (typeof msg.method === "string") return void onRequest(msg);

  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(msg.error.message ?? "erro no core"));
  else p.resolve(msg.result ?? {});
});

log("economia iniciado");
