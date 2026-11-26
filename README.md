# plugin platform

Bot de Discord onde **cada plugin pode ser escrito em qualquer linguagem**. O core não conhece
regra de negócio: ele roteia eventos, valida permissões e executa ações. O plugin nunca vê o token
do Discord.

```
Discord ──▶ adapter ──▶ router ──▶ processo do plugin (Python, Go, Ruby, Java, TypeScript…)
                            ◀── Action[] ── valida capability ──▶ Discord
```

## Rodar

```bash
git clone <repo> && cd discord-plugin-platform
npm run seed     # instala os 6 plugins de exemplo
npm run dev      # sobe o core + painel em http://127.0.0.1:4319
```

Não tem dependência. Node 22+ (usa `node:sqlite`). Para os plugins de exemplo, o runtime da
linguagem precisa existir na máquina: `python3`, `node`, `go`, `bun`, `ruby`, `java`.

Sem Discord, tudo funciona. O adapter padrão é o **mock**: as respostas aparecem no terminal e no
painel. Para conectar de verdade:

```bash
npm i discord.js
DISCORD_TOKEN=... DISCORD_APP_ID=... ADAPTER=discord npm start
```

## Comandos

```bash
npm run dev                      # serve + seed automático
npm start                        # só serve
npm run seed                     # instala os plugins de exemplo
npm run e2e                      # teste ponta a ponta com plugins reais
npm test                         # testes de unidade (manifesto, router, banco)

node core/cli.js conformance plugins/pets     # 6 testes de protocolo
node core/cli.js install plugins/pets         # instala um plugin local
node core/cli.js simulate pets pet            # dispara um comando sem Discord
node core/cli.js install <dir> --guild=1201,1202 --build
```

## Plugins de exemplo

Seis plugins reais, em seis linguagens, todos rodando pelo mesmo protocolo:

| plugin | linguagem | comandos | capabilities |
|---|---|---|---|
| `pets` | Python 3 | `!pet` `!petrank` | reply, kv, economy.read, economy.grant, emit |
| `economia` | JavaScript | `!saldo` `!daily` `!pagar` | reply, kv, economy.read, economy.grant, emit |
| `loja` | Go | `!loja` `!comprar` `!inventario` | reply, kv, economy.*, addRole |
| `cassino` | TypeScript (bun) | `!roleta` `!caraoucoroa` `!apostas` | reply, kv, economy.*, emit |
| `moderacao` | Ruby | `!aviso` `!historico` `!banir` | reply, kv, kick, addRole |
| `ranking` | Java | `!top` `!meu-top` | reply, economy.read |

Todos passam `conformance`. Todos respondem no E2E (`npm run e2e`, 68 verificações).

## Escrever um plugin

Um diretório com `plugin.toml` e um processo que fala JSON-RPC 2.0 em NDJSON sobre stdin/stdout.
Isso é o SDK inteiro:

```python
import sys, json

for line in sys.stdin:
    req = json.loads(line)
    method, params = req["method"], req.get("params", {})

    if method == "initialize":
        result = {"ok": True}
    elif method == "handleCommand" and params["command"] == "ping":
        result = [{"type": "reply", "content": "pong"}]
    elif method == "health":
        result = {"ok": True}
    else:
        result = []

    print(json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": result}), flush=True)
```

```toml
name = "ping"
version = "1.0.0"
lang = "python"
capabilities = ["reply"]

[[commands]]
name = "ping"
description = "Responde pong"

[runtime]
kind = "process"
cmd = ["python3", "main.py"]
timeout_ms = 3000
```

`stdout` é o protocolo — qualquer linha fora dele é erro de conformidade. Use `stderr` para log.
Detalhes completos em [`PROTOCOL.md`](PROTOCOL.md). Desenho interno em [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Segurança

Duas checagens, e ambas valem por guild:

1. **Chamada plugin → core** (`kv.set`, `economy.grant`, `http.fetch`): sem capability aprovada,
   resposta `-32003 E_CAPABILITY` e a chamada nem chega ao banco.
2. **Action plugin → Discord** (`reply`, `kick`, `addRole`, `emit`): action fora do escopo é
   descartada, logada e nunca executa.

O processo do plugin roda com ambiente limpo: `PATH`, `HOME`, `LANG` e as variáveis do próprio
plugin. Nenhum segredo do core. Crash → reinício com backoff (1 s, 2 s, 4 s); 3 falhas → `degraded`
e só volta com reinício manual.

## Painel

`http://127.0.0.1:4319` — servido pelo próprio core, consome `/api/*` de verdade:

- visão geral com volume de 24 h e plugins
- detalhe por plugin: métricas, comandos, permissões, configuração editável, logs, console JSON-RPC
- instalação guiada: analisa o diretório, mostra o manifesto, deixa aprovar permissão por permissão, instala e roda conformance
- logs globais com filtro por plugin e nível

Aberto como arquivo (`file://`), o painel cai em modo demonstração com dados fixos.

## Estrutura

```
core/
  cli.js              serve | seed | install | conformance | simulate
  src/
    index.js          boot()
    router.js         despacho + validação/execução de actions
    host.js           um processo por plugin, JSON-RPC, timeout, backoff
    db.js             SQLite: plugins, guilds, kv, economia, logs, métricas
    manifest.js       parser TOML + validação
    loader.js         instalação a partir de diretório
    conformance.js    os 6 testes de protocolo
    api.js            HTTP + /api/*
    seed.js           plugins de exemplo + dados de demonstração
    adapters/
      mock.js         roda sem Discord
      discord.js      discord.js carregado sob demanda
plugins/              6 plugins de exemplo (python, js, go, ts, ruby, java)
prototype/index.html  painel
tests/                e2e.mjs + testes de unidade + fixtures
```
