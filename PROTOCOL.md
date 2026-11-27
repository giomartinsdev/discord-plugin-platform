# Protocolo

JSON-RPC 2.0, uma mensagem JSON por linha (NDJSON), sobre stdin/stdout do processo do plugin.
Para containers, o mesmo protocolo sobre `POST /rpc`.

O plugin **nunca** vê o token do Discord. Ele devolve intenções (`Action[]`) e o core executa.

## Handshake

O core inicia o processo e envia `initialize`. Até receber a resposta, nenhuma outra chamada é feita.

```json
{"jsonrpc":"2.0","id":"c1","method":"initialize","params":{
  "pluginId":"pets",
  "version":"1.0.0",
  "guilds":[{"id":"1201","config":{"cooldown":30}}],
  "capabilities":["reply","kv"],
  "core":{"version":"0.1.0","protocol":1}
}}
```

Resposta:

```json
{"jsonrpc":"2.0","id":"c1","result":{"ok":true}}
```

## Métodos que o core chama

| método | params | result |
|---|---|---|
| `initialize` | `{pluginId, version, guilds, capabilities, core}` | `{ok:true}` |
| `handleCommand` | `{command, args, userId, guildId, channelId, messageId, isInteraction}` | `Action[]` |
| `handleEvent` | `{type, guildId, payload}` | `Action[]` |
| `health` | `{}` | `{ok:true, detail?, stats?}` |
| `shutdown` | `{reason}` | `{ok:true}` |

## Métodos que o plugin chama

Disponíveis apenas se a capability correspondente foi aprovada. Chamada sem permissão
retorna erro `-32003 E_CAPABILITY` sem chegar ao Discord.

| método | capability | params | result |
|---|---|---|---|
| `kv.get` | `kv` | `{guildId, key}` | `{value}` |
| `kv.set` | `kv` | `{guildId, key, value}` | `{ok:true}` |
| `kv.del` | `kv` | `{guildId, key}` | `{deleted}` |
| `kv.keys` | `kv` | `{guildId, prefix?}` | `{keys:[]}` |
| `kv.incr` | `kv` | `{guildId, key, by?}` | `{value}` |
| `economy.get` | `economy.read` | `{guildId, userId}` | `{balance}` |
| `economy.grant` | `economy.grant` | `{guildId, userId, amount, reason?}` | `{balance}` |
| `economy.top` | `economy.read` | `{guildId, limit?}` | `{entries:[{userId,balance}]}` |
| `config.get` | — | `{guildId}` | `{config}` |
| `log` | — | `{level, message}` | `{ok:true}` |
| `http.fetch` | `http` | `{url, method?, body?, headers?}` | `{status, body}` |

`http.fetch` só aceita hosts declarados em `manifest.allowed_hosts`.

## Actions (o que o plugin pode devolver)

```ts
type Action =
  | { type: "reply";          content: string; ephemeral?: boolean; channelId?: string }
  | { type: "editMessage";    messageId: string; content: string }
  | { type: "addRole";        userId: string; roleId: string }
  | { type: "removeRole";     userId: string; roleId: string }
  | { type: "kick";           userId: string; reason?: string }
  | { type: "emit";           topic: string; payload?: unknown }
  | { type: "schedule";       in: string; run: string; payload?: unknown };
```

Cada action tem capability própria (`reply`, `editMessage`, `addRole`, `removeRole`, `kick`,
`emit`, `scheduler`). Action não declarada é descartada e registrada em log — o plugin não
consegue escalar privilégio devolvendo uma action a mais.

`content` aceita markdown do Discord. `ephemeral` só vale em interação.

## Erros

Códigos JSON-RPC padrão, mais:

| código | nome | significado |
|---|---|---|
| -32001 | `E_TIMEOUT` | método não respondeu dentro do limite (padrão 3 s) |
| -32002 | `E_CRASH` | processo morreu durante a chamada |
| -32003 | `E_CAPABILITY` | capability não aprovada |
| -32004 | `E_PROTOCOL` | linha inválida, JSON quebrado, id desconhecido |
| -32005 | `E_INVALID_ACTION` | ação fora da união permitida |

## Ciclo de vida do processo

- spawn sob demanda na primeira chamada do plugin
- morte após 15 min ocioso
- crash → reinício com backoff (1 s, 2 s, 4 s), 3 tentativas, depois `degraded`
- `degraded` só volta com reinício manual pelo painel
- atualização vinda de repositório (`refresh`) mata o processo e sobe outro; guilds,
  permissões e configuração são preservadas
- stdout é protocolo. Qualquer linha não-JSON em stdout é erro de conformidade
- stderr é log livre, capturado e correlacionado por `request_id`

## Comandos ajustados pelo painel

O manifesto é a fonte da verdade, mas o painel pode sobrepor, por plugin:

- desligar um comando: sai do roteador e do Discord; o plugin não é reiniciado
- apelido: o core escuta o nome novo e chama o plugin com o nome original

O plugin nunca precisa saber que o nome mudou: `handleCommand` recebe sempre o nome do manifesto.

## Conformidade

Todo plugin passa por `bot-platform conformance <dir>` antes de instalar. Seis testes:

1. `initialize` responde em menos de 1 s
2. `handleCommand` devolve array de actions válidas
3. `handleEvent` devolve array (vazio é válido)
4. `health` responde
5. linha malformada não derruba o processo
6. chamada lenta é interrompida no limite e o processo continua vivo
