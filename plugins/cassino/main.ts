/**
 * Plugin de cassino — exemplo em TypeScript, rodando direto com bun.
 *
 * Protocolo: JSON-RPC 2.0, uma mensagem por linha, em stdin/stdout.
 * Node puro não executa .ts, então o runtime do manifesto é `bun`.
 */
import { createInterface } from "node:readline";

type Action =
  | { type: "reply"; content: string }
  | { type: "emit"; topic: string; payload?: unknown };

type Config = { min_bet: number; max_bet: number; house_edge: number };

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const configs = new Map<string, Partial<Config>>();
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let seq = 0;

const send = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
const log = (msg: string, level = "info") => process.stderr.write(`[${level}] ${msg}\n`);

function core<T = any>(method: string, params: Record<string, unknown>): Promise<T> {
  const id = `t${++seq}`;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise<T>((resolve, reject) => pending.set(id, { resolve, reject }));
}

/* ── utilidades ── */

const coins = (n: number) => `${n.toLocaleString("pt-BR")} moedas`;
const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

type Stats = { bets: number; wins: number; net: number };
const emptyStats = (): Stats => ({ bets: 0, wins: 0, net: 0 });

/* ── roleta ── */

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

async function roleta(args: string[], userId: string, guildId: string): Promise<Action[]> {
  const cfg = configs.get(guildId) ?? {};
  const minBet = cfg.min_bet ?? 10;
  const maxBet = cfg.max_bet ?? 500;

  const bet = Math.floor(Number(args[1]));
  const on = (args[0] ?? "").toLowerCase();

  if (!["vermelho", "preto", "verde"].includes(on) && !/^\d{1,2}$/.test(on)) {
    return [{ type: "reply", content: "Escolha `vermelho`, `preto`, `verde` ou um número de 0 a 36." }];
  }
  if (!Number.isFinite(bet) || bet < minBet) {
    return [{ type: "reply", content: `Aposta mínima é **${coins(minBet)}**.` }];
  }
  if (bet > maxBet) {
    return [{ type: "reply", content: `Aposta máxima é **${coins(maxBet)}**.` }];
  }

  const { balance } = await core<{ balance: number }>("economy.get", { guildId, userId });
  if (balance < bet) {
    return [{ type: "reply", content: `Saldo insuficiente. Você tem **${coins(balance)}**.` }];
  }

  const spin = Math.floor(Math.random() * 37);
  const spinColor = spin === 0 ? "verde" : RED.has(spin) ? "vermelho" : "preto";
  const numberHit = /^\d+$/.test(on) && Number(on) === spin;
  const colorHit = (on === "vermelho" || on === "preto" || on === "verde") && on === spinColor;

  await core("economy.grant", { guildId, userId, amount: -bet, reason: "aposta roleta" });

  let payout = 0;
  let label = "";
  if (numberHit) { payout = bet * 36; label = "acertou em cheio"; }
  else if (colorHit) { payout = bet * (spinColor === "verde" ? 14 : 2); label = "acertou a cor"; }

  if (payout > 0) {
    await core("economy.grant", { guildId, userId, amount: payout, reason: "prêmio roleta" });
  }

  const stats = await bumpStats(guildId, userId, { bets: 1, wins: payout > 0 ? 1 : 0, net: payout - bet });
  const colorName = spinColor === "vermelho" ? "vermelho" : spinColor === "preto" ? "preto" : "verde";

  const first = `Deu **${spin}** (${colorName}).`;
  const second = payout > 0
    ? `Você ${label} e levou **${coins(payout)}**.`
    : `Você perdeu **${coins(bet)}**.`;

  return [{
    type: "reply",
    content: `${first} ${second}\nSaldo: **${coins(balance - bet + payout)}** · apostas: ${stats.bets} · lucro: ${stats.net >= 0 ? "+" : ""}${stats.net}`,
  }];
}

/* ── cara ou coroa ── */

async function caraoucoroa(args: string[], userId: string, guildId: string): Promise<Action[]> {
  const cfg = configs.get(guildId) ?? {};
  const minBet = cfg.min_bet ?? 10;
  const maxBet = cfg.max_bet ?? 500;
  const edge = (cfg.house_edge ?? 5) / 100;

  const side = (args[0] ?? "").toLowerCase();
  const bet = Math.floor(Number(args[1]));

  if (!["cara", "coroa"].includes(side)) {
    return [{ type: "reply", content: "Escolha `cara` ou `coroa`. Exemplo: `!caraoucoroa cara 50`." }];
  }
  if (!Number.isFinite(bet) || bet < minBet || bet > maxBet) {
    return [{ type: "reply", content: `Aposta entre **${coins(minBet)}** e **${coins(maxBet)}**.` }];
  }

  const { balance } = await core<{ balance: number }>("economy.get", { guildId, userId });
  if (balance < bet) {
    return [{ type: "reply", content: `Saldo insuficiente. Você tem **${coins(balance)}**.` }];
  }

  const flip = pick(["cara", "coroa"]);
  const win = flip === side;
  const payout = win ? Math.round(bet * 2 * (1 - edge)) : 0;

  await core("economy.grant", { guildId, userId, amount: -bet, reason: "aposta moeda" });
  if (payout > 0) await core("economy.grant", { guildId, userId, amount: payout, reason: "prêmio moeda" });

  const stats = await bumpStats(guildId, userId, { bets: 1, wins: win ? 1 : 0, net: payout - bet });
  const result = win ? `Deu **${flip}**. Você ganhou **${coins(payout)}**.` : `Deu **${flip}**. Você perdeu **${coins(bet)}**.`;

  return [{
    type: "reply",
    content: `${result}\nSaldo: **${coins(balance - bet + payout)}** · taxa da casa: ${Math.round(edge * 100)}%`,
    // stats já persistidas; o campo abaixo é só para o painel correlacionar
  }, {
    type: "emit",
    topic: "cassino.played",
    payload: { userId, game: "moeda", bet, payout, stats },
  }];
}

/* ── estatísticas ── */

async function bumpStats(guildId: string, userId: string, delta: Stats): Promise<Stats> {
  const key = `stats:${userId}`;
  const { value } = await core<{ value: Stats | null }>("kv.get", { guildId, key });
  const cur = value ?? emptyStats();
  const next: Stats = {
    bets: cur.bets + delta.bets,
    wins: cur.wins + delta.wins,
    net: cur.net + delta.net,
  };
  await core("kv.set", { guildId, key, value: next });
  return next;
}

async function apostas(_args: string[], userId: string, guildId: string): Promise<Action[]> {
  const { value } = await core<{ value: Stats | null }>("kv.get", { guildId, key: `stats:${userId}` });
  const s = value ?? emptyStats();
  if (!s.bets) return [{ type: "reply", content: "Você ainda não apostou nada. Tente `!roleta vermelho 50`." }];

  const rate = Math.round((s.wins / s.bets) * 100);
  return [{
    type: "reply",
    content: `**Suas apostas**\n${s.bets} apostas · ${s.wins} vitórias (${rate}%)\nlucro: **${s.net >= 0 ? "+" : ""}${coins(s.net)}**`,
  }];
}

/* ── roteamento ── */

const COMMANDS: Record<string, (a: string[], u: string, g: string) => Promise<Action[]>> = {
  roleta, caraoucoroa, apostas,
};

async function onRequest(msg: any): Promise<void> {
  const { id, method, params = {} } = msg;
  const guildId = String(params.guildId ?? "0");

  try {
    switch (method) {
      case "initialize": {
        for (const g of params.guilds ?? []) {
          const { config } = await core<{ config: Partial<Config> }>("config.get", { guildId: g.id });
          configs.set(g.id, config ?? {});
        }
        log(`inicializado para ${(params.guilds ?? []).length} servidor(es)`);
        return send({ jsonrpc: "2.0", id, result: { ok: true } });
      }
      case "handleCommand": {
        const fn = COMMANDS[params.command];
        const actions = fn
          ? await fn(params.args ?? [], params.userId ?? "0", guildId)
          : [{ type: "reply" as const, content: `Comando \`${params.command}\` não existe aqui.` }];
        return send({ jsonrpc: "2.0", id, result: actions });
      }
      case "handleEvent":
        return send({ jsonrpc: "2.0", id, result: [] });
      case "health":
        return send({ jsonrpc: "2.0", id, result: { ok: true, detail: "cassino ativo" } });
      case "shutdown":
        send({ jsonrpc: "2.0", id, result: { ok: true } });
        return void process.exit(0);
      default:
        return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `método desconhecido: ${method}` } });
    }
  } catch (err) {
    log(`erro em ${method}: ${(err as Error).message}`, "error");
    send({ jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message } });
  }
}

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;

  let msg: any;
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

log("cassino iniciado");
