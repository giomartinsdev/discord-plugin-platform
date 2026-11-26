import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";

/**
 * Conformidade: roda o plugin como o core rodaria e valida o protocolo.
 * Sem Discord, sem banco. É o teste que o dev roda no CI.
 */
export async function runConformance(dir, manifest, { timeoutMs = 3000, onLog = () => {} } = {}) {
  const results = [];
  const add = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    onLog(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
  };

  const rt = manifest.runtime;
  if (rt.kind !== "process") {
    add("runtime de processo", false, `kind = ${rt.kind}: conformidade local requer process`);
    return { ok: false, results };
  }

  const [cmd, ...args] = rt.cmd;
  const cwd = join(dir, rt.cwd ?? ".");
  const child = spawn(cmd, args, {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", PYTHONUNBUFFERED: "1", NODE_OPTIONS: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let seq = 0;
  const waiting = new Map();
  const stray = [];
  const pluginCalls = [];
  let malformed = 0;
  let stderrLast = "";

  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    const t = line.trim();
    if (!t) return;
    try {
      const msg = JSON.parse(t);
      if (typeof msg.method === "string") {
        // plugin chamando o core: respondemos com stubs para o teste não travar
        const result = stubFor(msg.method, msg.params ?? {});
        if (result !== undefined) {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
        } else {
          pluginCalls.push(msg.method);
          child.stdin.write(JSON.stringify({
            jsonrpc: "2.0", id: msg.id,
            error: { code: -32003, message: `capability não aprovada: ${msg.method}` },
          }) + "\n");
        }
        return;
      }
      const w = waiting.get(msg.id);
      if (w) { waiting.delete(msg.id); w(msg); }
    } catch {
      malformed++;
      stray.push(line);
    }
  });
  createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (l) => { stderrLast = l; });

  const call = (method, params = {}, limit = timeoutMs) => new Promise((resolve) => {
    const id = `t${++seq}`;
    const timer = setTimeout(() => { waiting.delete(id); resolve({ timeout: true }); }, limit);
    waiting.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    try { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); }
    catch { clearTimeout(timer); resolve({ crashed: true }); }
  });

  const alive = () => child.exitCode === null && !child.killed;

  try {
    const init = await call("initialize", { pluginId: manifest.id, version: manifest.version, guilds: [], capabilities: manifest.capabilities, core: { version: "0.1.0", protocol: 1 } }, 5000);
    add("initialize responde", !init.timeout && !init.error, init.timeout ? "timeout" : "");

    const cmdName = manifest.commands[0]?.name;
    if (cmdName) {
      const r = await call("handleCommand", { command: cmdName, args: [], guildId: "1", userId: "1", channelId: "1" });
      const ok = Array.isArray(r.result);
      add("handleCommand devolve ações", ok, ok ? `${r.result.length} ação(ões)` : r.error?.message ?? "resultado não é array");
    } else {
      add("handleCommand devolve ações", true, "sem comandos declarados");
    }

    if (manifest.events.length) {
      const r = await call("handleEvent", { type: manifest.events[0], guildId: "1", payload: { userId: "1" } });
      add("handleEvent devolve ações", Array.isArray(r.result));
    } else {
      add("handleEvent devolve ações", true, "sem eventos declarados");
    }

    const h = await call("health", {});
    add("health responde", !h.timeout && !h.error);

    // linha malformada não pode derrubar
    try { child.stdin.write("isto não é json\n"); } catch {}
    const after = await call("health", {}, 1500);
    add("linha inválida não derruba", !after.timeout && alive());

    add("stdout limpo", malformed === 0, malformed ? `${malformed} linha(s) fora do protocolo` : "");
  } finally {
    try { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: "bye", method: "shutdown", params: { reason: "conformance" } }) + "\n"); } catch {}
    await new Promise((r) => setTimeout(r, 80));
    try { child.kill("SIGKILL"); } catch {}
  }

  const ok = results.every((r) => r.ok);
  if (!ok && stderrLast) onLog(`stderr: ${stderrLast}`);
  return { ok, results, pluginCalls };
}

/**
 * Respostas falsas para as chamadas plugin→core durante a conformidade.
 * Sem banco: só o suficiente para o handler rodar sem travar no stdin.
 */
function stubFor(method, params) {
  switch (method) {
    case "config.get": return { config: {} };
    case "kv.get": return { value: null };
    case "kv.set": return { ok: true, value: params.value };
    case "kv.del": return { deleted: true };
    case "kv.keys": return { keys: [] };
    case "kv.incr": return { value: 1 };
    case "economy.get": return { balance: 1000 };
    case "economy.grant": return { balance: 1000 };
    case "economy.top": return { entries: [] };
    case "log": return { ok: true };
    case "http.fetch": return undefined;
    default: return undefined;
  }
}
