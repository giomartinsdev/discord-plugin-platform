# Arquitetura

## A ideia em uma frase

O bot é um **roteador de eventos**; tudo que tem regra de negócio é plugin, e plugin pode ser escrito
em qualquer linguagem que saiba ler `stdin` e escrever `stdout`.

```
Discord ──▶ adapter ──▶ Router ──▶ PluginHost ──▶ processo do plugin (qualquer linguagem)
                            ◀── Action[] ── valida capability ──▶ adapter ──▶ Discord
```

O plugin **nunca** recebe o token do Discord. Ele devolve intenções (`Action[]`), e o core decide se
executa. Essa é a fronteira de segurança inteira: um plugin comprometido pode, no máximo, devolver
uma action que ele já tinha permissão de executar.

## Componentes

| arquivo | papel |
|---|---|
| `core/src/index.js` | `boot()`: monta store, adapter, router, API. É o único ponto de entrada. |
| `core/src/router.js` | dono dos hosts, despacha comando/evento, **valida e executa** cada action. |
| `core/src/host.js` | um processo por plugin. JSON-RPC sobre stdio, fila serial, timeout, backoff, idle kill. |
| `core/src/db.js` | SQLite (`node:sqlite`). Plugins, instalações por guild, KV, economia, logs, métricas. |
| `core/src/manifest.js` | parser TOML mínimo + `normalizeManifest` com validação. |
| `core/src/loader.js` | lê manifesto, detecta linguagem, copia para `.plugins/<id>`, fixa commit git. |
| `core/src/conformance.js` | 6 testes de protocolo que qualquer plugin precisa passar. |
| `core/src/api.js` | HTTP + JSON: serve o painel e expõe `/api/*`. |
| `core/src/adapters/mock.js` | roda tudo sem Discord. |
| `core/src/adapters/discord.js` | `discord.js` importado sob demanda; token só aqui. |
| `core/cli.js` | `serve`, `seed`, `install`, `conformance`, `simulate`. |

## Por que processo separado

- **Falha isolada**: plugin em loop infinito ou `segfault` não derruba o bot. O host mata e reinicia.
- **Sem SDK**: o contrato é stdio + JSON. Python, Go, Ruby, Java e bun usam exatamente o mesmo código.
- **Permissão por processo**: o processo só tem as variáveis de ambiente que o host injeta — nunca segredos.

Container (HTTP) está no protocolo (`runtime.kind = "container"`), mas o host só implementa processo.
Adicionar container é implementar `spawnChild` alternativo em `host.js`; nada mais muda.

## Por que capability dupla

Existem duas checagens, e as duas são necessárias:

1. **Chamada plugin → core** (`kv.set`, `economy.grant`, `http.fetch`): checada em `onPluginRequest`.
   Sem a capability, a resposta é `E_CAPABILITY -32003` e a chamada nunca chega ao banco.
2. **Action plugin → Discord** (`reply`, `kick`, `addRole`, `emit`): checada em `validateAction`.
   Action fora do escopo é **descartada**, registrada em log e nunca executada.

A capability é aprovada **por guild** (`plugin_guild.approved_caps`). O mesmo plugin pode ter
`economy.grant` num servidor e não ter em outro. `hasCap(guildId, cap)` consulta a instalação.

## Fluxo de um comando

```
!saldo
  adapter → router.dispatchCommand({command:"saldo", guildId:"1201", userId:"4410"})
    → encontra hosts cujo manifesto declara "saldo" e que estão instalados em 1201
    → host.call("handleCommand", {...})            [timeout 3 s, fila serial]
        plugin responde [{type:"reply", content:"..."}]
    → validateAction: reply exige capability "reply" aprovada em 1201 ✓
    → adapter.sendMessage(...)                     [mock imprime; discord.js envia]
    → call_stat: método, ok, duração
```

## Fluxo de uma chamada plugin → core

```
plugin quer dar moedas
  → escreve {"jsonrpc":"2.0","id":"p1","method":"economy.grant","params":{...}}
  → host.onPluginRequest
      CAPABILITY_FOR["economy.grant"] === "economy.grant"
      hasCap(guildId, "economy.grant")? não → error -32003, log source=capability
      sim → handlers.econGrant(...) → {balance}
  → resposta na mesma linha
```

O plugin faz a chamada de forma **síncrona**: escreve o pedido e lê linhas até achar o próprio id.
Como o host serializa as chamadas principais, não existe concorrência durante essa espera.

## Banco

Um arquivo SQLite em `.data/platform.db` (WAL). Tabelas:

- `plugin` — registro do plugin, versão, commit, runtime, manifesto.
- `plugin_guild` — instalação por servidor: habilitado, config, **capabilities aprovadas**.
- `kv` — dados do plugin, isolados por `(plugin_id, guild_id, key)`.
- `economy` — saldo da moeda global, por `(guild_id, user_id)`. **Serviço do core**, não de plugin.
- `event_log` — todo log, correlacionado por `request_id`.
- `call_stat` — métricas por chamada. Base do p95 e do volume por hora.

Economia é do core de propósito: se cada plugin tivesse a própria moeda, `loja` não conseguiria
cobrar o saldo de `economia`, e o painel não teria uma visão única.

## Conformidade

`runConformance` sobe o plugin sozinho e responde as chamadas plugin → core com stubs. Seis checagens:

1. `initialize` responde em < 1 s
2. `handleCommand` devolve array de actions
3. `handleEvent` devolve array (vazio é válido)
4. `health` responde
5. linha malformada em stdin não derruba o processo
6. stdout limpo — nenhuma linha fora do protocolo

Rodar antes de instalar é o equivalente a um teste de contrato. `npm run conformance <dir>`.

## O que ficou de fora, de propósito

- **Assinatura de plugin**: instalar exige acesso ao diretório/repo. Sem sandbox de sistema de arquivos.
- **HTTP para plugin de rede**: `http.fetch` existe mas nenhum plugin de exemplo usa.
- **Slash commands automáticos**: o adapter registra o nome/descrição; opções ainda não são sincronizadas.
- **Fila distribuída**: um processo Node, um banco local. Escala vertical, não horizontal.
