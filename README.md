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

Não tem dependência obrigatória. Node 22+ (usa `node:sqlite`). Para os plugins de exemplo, o
runtime da linguagem precisa existir na máquina: `python3`, `node`, `go`, `bun`, `ruby`, `java`.

Sem Discord, tudo funciona. O adapter padrão é o **mock**: as respostas aparecem no terminal e no
painel. Para conectar de verdade:

```bash
npm i                 # instala discord.js (optionalDependencies)
cp .env.example .env  # preencha DISCORD_TOKEN, DISCORD_APP_ID e ADAPTER=discord
npm start
```

`.env` é lido no boot (`process.loadEnvFile`) e está no `.gitignore`. No Discord real:

- as guilds do painel vêm do gateway, não do seed — o bot precisa estar no servidor
- `npm run seed` instala os 6 plugins em todos os servidores em que o bot está
- os slash commands (`/saldo`, `/pet`, …) são registrados automaticamente no boot e a cada
  `install`
- comandos com `!` também funcionam; ambos passam pelo mesmo roteador
- o adapter adia a resposta se o plugin passar de 2 s, porque o Discord exige ACK em 3 s

**Permissões no portal do Discord** (OAuth2 → URL Generator): escopos `bot` e
`applications.commands`; no bot, marque `Read Messages`, `Send Messages`, `Manage Roles` (loja e
moderação) e `Kick Members` (moderação). Para ler o conteúdo das mensagens `!comando`, ative
**Message Content Intent** em Bot → Privileged Gateway Intents.

**Cargos**: `addRole`/`removeRole` exigem que o cargo do bot fique **acima** dos cargos que ele
atribui. Os IDs de cargo vêm da config de cada plugin (ex.: `mute_role = "9100"` na moderação) —
troque pelos IDs reais do seu servidor no painel, aba Configuração.

## Instalar pelo link do repositório

No painel, **Instalar plugin** aceita uma URL de repositório git (`https://`, `git@`, `ssh://`) ou
um diretório local:

1. cola `https://github.com/usuario/meu-plugin`
2. o core clona num diretório de trabalho e lê o `plugin.toml`
3. escolhe permissões e servidores e instala

O core guarda a origem. Depois, no plugin → aba **Comandos** → **Puxar commits novos**:

- faz `git fetch` do branch e reinstala a cópia em `.plugins/`
- reinicia **só aquele plugin** (o bot continua no ar)
- relê o manifesto, então comandos novos, removidos ou com descrição nova entram em vigor
- re-registra os slash commands no Discord
- preserva guilds, permissões aprovadas e configuração

## Comandos pela tela

Plugin → aba **Comandos**:

- **desligar** um comando: ele some do roteador e do Discord, sem tocar no repositório
- **apelido**: o comando passa a responder por outro nome (`/pong` em vez de `/ping`); o plugin
  continua recebendo o nome original
- salvar aplica na hora, inclusive nos slash commands

O manifesto continua sendo a fonte da verdade; os ajustes ficam no banco, por plugin.

## Comandos

```bash
npm run dev                      # serve + seed automático
npm start                        # só serve
npm run seed                     # instala os plugins de exemplo
npm run e2e                      # teste ponta a ponta com plugins reais
npm test                         # testes de unidade (manifesto, router, banco)

node core/cli.js conformance plugins/pets     # 6 testes de protocolo
node core/cli.js install plugins/pets         # instala um plugin local
node core/cli.js install https://github.com/u/repo   # instala de um repositório
node core/cli.js refresh pets                 # git pull + reload em runtime
node core/cli.js simulate pets pet            # dispara um comando sem Discord
node core/cli.js install <dir|url> --guild=1201,1202 --branch=main --build
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

Todos passam `conformance`. Todos respondem no E2E (`npm run e2e`, 69 verificações).

Se quiser começar do zero, há três repositórios de exemplo mínimos — mesmo plugin (`contador` por
membro) em linguagens diferentes:

- [plugin-starter-python](https://github.com/giomartinsdev/plugin-starter-python)
- [plugin-starter-node](https://github.com/giomartinsdev/plugin-starter-node)
- [plugin-starter-go](https://github.com/giomartinsdev/plugin-starter-go)

```bash
git clone https://github.com/giomartinsdev/plugin-starter-python
node core/cli.js conformance ../plugin-starter-python
node core/cli.js install ../plugin-starter-python
node core/cli.js simulate contador contar
```

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
