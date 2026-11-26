#!/usr/bin/env python3
"""Plugin de pets — exemplo de referência do protocolo.

Fala JSON-RPC 2.0 em NDJSON sobre stdin/stdout. Sem SDK, sem dependência.
stdout é o canal do protocolo; logs vão para stderr.
"""
import json
import random
import sys
import time

CONFIG = {}
GUILD_IDS = []
PET_NAMES = ["Bilu", "Mimi", "Tofu", "Nino", "Kira", "Zeca", "Fumaça", "Pipoca", "Bento", "Luna"]

# ---------------------------------------------------------------- protocolo


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def reply(req_id, result):
    send({"jsonrpc": "2.0", "id": req_id, "result": result})


def fail(req_id, code, message):
    send({"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}})


def log(message, level="info"):
    sys.stderr.write(f"[{level}] {message}\n")
    sys.stderr.flush()


# ---------------------------------------------------------------- domínio

HUNGER_PER_HOUR = 4
COOLDOWN = 30


def default_pet(user_id):
    return {
        "userId": user_id,
        "name": random.choice(PET_NAMES),
        "hunger": 0,
        "happiness": 5,
        "bornAt": int(time.time() * 1000),
        "lastCare": 0,
        "cares": 0,
    }


def decay(pet):
    """Aplica fome acumulada desde o último cuidado."""
    now = int(time.time() * 1000)
    elapsed_h = max(0, (now - pet["lastCare"]) / 3_600_000)
    pet["hunger"] = min(10, round(pet["hunger"] + elapsed_h * HUNGER_PER_HOUR, 1))
    return pet


def describe(pet):
    filled = int(round(pet["hunger"] / 2))
    bar = "█" * filled + "░" * (5 - filled)
    mood = "faminto" if pet["hunger"] >= 8 else "ok" if pet["hunger"] >= 4 else "satisfeito"
    return (
        f"**{pet['name']}** — fome `{bar}` {pet['hunger']:.1f}/10 ({mood})\n"
        f"felicidade {pet['happiness']}/10 · {pet['cares']} cuidados"
    )


# ---------------------------------------------------------------- handlers


def handle_pet(args, user_id, guild_id):
    key = f"pet:{user_id}"
    pet = call_core("kv.get", {"guildId": guild_id, "key": key}).get("value")

    if not pet:
        pet = default_pet(user_id)
        pet["lastCare"] = int(time.time() * 1000)
        call_core("kv.set", {"guildId": guild_id, "key": key, "value": pet})
        actions = [{"type": "reply", "content": f"Você adotou **{pet['name']}**! Use `!pet` para cuidar."}]
        return actions

    pet = decay(pet)
    now = int(time.time() * 1000)
    waited = (now - pet["lastCare"]) / 1000

    if waited < COOLDOWN:
        remaining = int(COOLDOWN - waited)
        return [{"type": "reply", "content": f"{pet['name']} ainda está descansando. Tente em {remaining}s."}]

    pet["hunger"] = max(0, pet["hunger"] - 3)
    pet["happiness"] = min(10, pet["happiness"] + 1)
    pet["cares"] += 1
    pet["lastCare"] = now
    call_core("kv.set", {"guildId": guild_id, "key": key, "value": pet})

    reward = call_core("config.get", {"guildId": guild_id}).get("config", {}).get("reward", 10)
    call_core("economy.grant", {"guildId": guild_id, "userId": user_id, "amount": reward, "reason": "cuidar do pet"})

    return [
        {"type": "reply", "content": describe(pet) + f"\n+{reward} moedas por cuidar."},
        {"type": "emit", "topic": "pets.cared", "payload": {"userId": user_id, "cares": pet["cares"]}},
    ]


def handle_petrank(args, user_id, guild_id):
    keys = call_core("kv.keys", {"guildId": guild_id, "prefix": "pet:"}).get("keys", [])
    if not keys:
        return [{"type": "reply", "content": "Ninguém adotou um pet ainda. Use `!pet` para começar."}]

    pets = []
    for k in keys:
        p = call_core("kv.get", {"guildId": guild_id, "key": k}).get("value")
        if p:
            pets.append(p)

    pets.sort(key=lambda p: (p["cares"], p["happiness"]), reverse=True)
    lines = ["**Ranking de pets**", ""]
    for i, p in enumerate(pets[:10], 1):
        medal = {1: "🥇", 2: "🥈", 3: "🥉"}.get(i, f"{i}.")
        lines.append(f"{medal} **{p['name']}** — {p['cares']} cuidados · felicidade {p['happiness']}/10")
    return [{"type": "reply", "content": "\n".join(lines)}]


def handle_event(event_type, payload, guild_id):
    if event_type == "MESSAGE_CREATE" and "pet" in (payload.get("content") or "").lower():
        log(f"mensagem menciona pet de {payload.get('userId')}")
    return []


# ---------------------------------------------------------------- core calls

_seq = 0
_pending = {}


def call_core(method, params):
    """Chamada síncrona ao core. O protocolo é serial, então bloqueia até responder."""
    global _seq
    _seq += 1
    req_id = f"plugin-{_seq}"
    send({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
    while True:
        line = sys.stdin.readline()
        if not line:
            raise RuntimeError("core fechou a conexão")
        msg = json.loads(line)
        if "method" in msg:
            route_incoming(msg)
            continue
        if msg.get("id") != req_id:
            continue
        if "error" in msg:
            raise RuntimeError(msg["error"].get("message", "erro no core"))
        return msg.get("result") or {}


# ---------------------------------------------------------------- roteamento

CORE_METHODS = {"kv.get", "kv.set", "kv.del", "kv.keys", "kv.incr",
                "economy.get", "economy.grant", "economy.top", "config.get",
                "log", "http.fetch"}


def route_incoming(msg):
    """Chamada do core durante um call_core: responde e segue."""
    method = msg.get("method")
    if method == "log":
        log(msg.get("params", {}).get("message", ""))
        reply(msg["id"], {"ok": True})
    elif method in ("initialize", "health", "shutdown"):
        reply(msg["id"], {"ok": True})
    else:
        fail(msg["id"], -32601, f"método inesperado durante chamada: {method}")


def on_initialize(params):
    global CONFIG, GUILD_IDS, COOLDOWN, HUNGER_PER_HOUR
    GUILD_IDS = [g["id"] for g in params.get("guilds", [])]
    log(f"inicializado para {len(GUILD_IDS)} guild(s)")
    return {"ok": True}


def on_command(params):
    command = params.get("command")
    args = params.get("args") or []
    user_id = params.get("userId", "0")
    guild_id = params.get("guildId", "0")

    if command == "pet":
        return handle_pet(args, user_id, guild_id)
    if command == "petrank":
        return handle_petrank(args, user_id, guild_id)
    return [{"type": "reply", "content": f"Comando `{command}` não existe neste plugin."}]


def main():
    log("pets iniciado")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            log(f"linha inválida: {line[:80]}", "warn")
            continue

        method = msg.get("method")
        req_id = msg.get("id")
        params = msg.get("params") or {}

        try:
            if method == "initialize":
                reply(req_id, on_initialize(params))
            elif method == "handleCommand":
                reply(req_id, on_command(params))
            elif method == "handleEvent":
                reply(req_id, handle_event(params.get("type"), params.get("payload") or {}, params.get("guildId", "0")))
            elif method == "health":
                reply(req_id, {"ok": True, "detail": "pets ativo"})
            elif method == "shutdown":
                reply(req_id, {"ok": True})
                log("encerrando")
                return
            else:
                fail(req_id, -32601, f"método desconhecido: {method}")
        except Exception as exc:  # noqa: BLE001
            log(f"erro em {method}: {exc}", "error")
            fail(req_id, -32000, str(exc))


if __name__ == "__main__":
    main()
