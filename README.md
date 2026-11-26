# discord-plugin-platform

Bot de Discord agnóstico de linguagem: devs escrevem plugins em **qualquer linguagem** e instalam no servidor via painel.

## Estado

- `prototype/index.html` — protótipo do painel, dados mockados, zero build. Abre no browser.
- Nada de backend ainda. O protótipo é o contrato visual.

## Ideia em uma frase

Plugin = processo + protocolo JSON-RPC 2.0 (NDJSON sobre stdio). Não importa a linguagem
porque o core nunca importa código de plugin — só fala socket.

```
core (roteia eventos Discord) ──JSON-RPC──► plugin Python / Rust / Go / C# / ...
        │
        └── ações voltam como Action[] → core valida capability → core executa no Discord
```

Token nunca sai do core. Plugin só devolve intenções.

## Documentos

- `prototype/index.html` — painel (visão geral, plugins, config gerada do schema, logs, wizard de install, console RPC, protocolo)
- `PROTOCOL.md` — spec do protocolo (a escrever)
- `ARCHITECTURE.md` — decisões (a escrever)

## Roadmap

1. spec do protocolo + supervisor de processo + mock gateway (validar com 1 plugin Python + 1 TS)
2. conformance suite + SDKs finos (Py, TS, Go)
3. KV + economia no protocolo + plugins reais (pets, loja)
4. painel de verdade → git webhook + build → runtime container
