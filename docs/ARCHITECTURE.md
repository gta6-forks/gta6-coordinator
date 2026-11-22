# Arquitetura

```
                         ┌──────────────────────── Cloudflare ────────────────────────┐
 Participante            │                                                            │
 (Claude Code + MCP) ──▶ │  Worker (src/worker.js)                                    │
                         │   ├─ Static Assets: public/ (landing, onboarding)          │
 Navegador ────────────▶ │   ├─ /auth/google/* ── OIDC ──▶ accounts.google.com        │
                         │   │      state/PKCE/nonce, JWKS ──▶ KV (OAUTH_KV)           │
                         │   ├─ /auth/anonymous                                       │
                         │   └─ /mcp, /api/* ──────────┐                              │
                         │                             ▼                              │
                         │  Durable Object "Coordinator" (instância global, SQLite)   │
                         │   ├─ src/app.js (rotas internas)                           │
                         │   ├─ src/mcp/server.js (JSON-RPC, ferramentas)             │
                         │   ├─ services: auth · catalog · scheduler · review · planning
                         │   └─ tabelas: participants, tokens, tasks, reservations,   │
                         │      idempotency, completions, reviews, verifications,     │
                         │      merge_intents, proposals, rate_limits, events, meta   │
                         │  Cron (30 min) ──▶ /internal/sync                          │
                         └────────────────────────────────────────────────────────────┘
                                   │ GitHub App (só backend)          ▲ webhooks (HMAC) · callback do integrador
                                   ▼                                  │
                         GitHub
                          ├─ 5 forks principais (integração, Issues centrais, branches task/<issue>, PRs)
                          ├─ repositório coordenador (planejamento, workflow integrador no Actions)
                          └─ org de trabalho: um repo privado por reserva (w-<id>)
                                   ▲
 Participante ── git clone/pull/push nativo (HTTPS) ──┘  credencial: token de 1 h, só aquele repo,
                                                          via credential helper → POST /api/git/credential
```

## Por que estas peças

- **Worker na borda, Durable Object como escritor único.** Toda operação que muda estado entra no mesmo objeto e roda
  em `transactionSync`. A elegibilidade (dependências, perfil, independência do verificador) é lida e a reserva é
  gravada na mesma transação; não há corrida entre dois participantes.
- **KV só para o que tolera consistência eventual**: `state` do OAuth (escrito e lido pelo mesmo usuário em segundos;
  apagado no primeiro uso) e cache do JWKS.
- **Sem R2 no MVP**: tudo que é entrega vai no Git.
- **Integrador no GitHub Actions**: Workers não rodam `git` e Containers estão fora do desenho. O workflow do
  repositório coordenador faz o fetch do repo de trabalho, a varredura e o fast-forward da branch de tarefa.

### Repositório de trabalho
`claim_next_task` → `get_workspace` (cria `w-<id>` uma vez por reserva) → o participante configura o
*credential helper* → `git push` direto no GitHub (o helper pede ao Worker um token restrito ao repo; o Worker
confere reserva ativa + caminho exato) → `submit_completion` com `workspace_id` (reserva segue ativa) → Worker
dispara o integrador → callback `integrated` (mesmo SHA, PR no fork principal) → nascem as duas verificações e a
reserva fecha → `reconcileWorkspaces` arquiva o repo e, depois da retenção, apaga. `conflict`/`error` devolvem o
workspace; `forbidden_content` revoga e apaga na hora. Detalhes e limites: `docs/GITHUB_ISOLATION.md`.

## Fluxos

### Login Google
1. `GET /auth/google/start`: gera `state`, `code_verifier`, `nonce`; grava em KV por 10 min; redireciona ao Google
   com `code_challenge` S256.
2. `GET /auth/google/callback?code&state`: consome o `state` (apaga do KV), troca o `code` no endpoint de token com
   `client_secret` + `code_verifier`, verifica o ID token, cria/acha o participante pelo `sub` e mostra o token do
   coordenador uma vez (`Cache-Control: no-store`, CSP restrita).

### Reserva
`claim_next_task` → varre expiradas → confere idempotência → recusa se o participante já tem reserva ativa →
ordena candidatas → avalia cada uma (executável, `ready`, `open`, dependências, reservada, Google se estratégica,
independência se verificação, perfil) → `INSERT … WHERE EXISTS(status='open')` protegido pelos índices únicos.

### Revisão
`submit_completion` (valida schema, extensões proibidas, repositório do PR) → cria revisão e duas tarefas
`local:verify/<rev>/1|2` com os requisitos de **validação** da tarefa original → `submit_verification` (mesmo commit,
verificador independente) → reprovação gera `local:plan/replan/<rev>` → duas aprovações + `/api/ci success` →
`ready_to_merge` + merge intent no adaptador (pendente) → webhook `pr_merged` → `done`, o que desbloqueia dependentes.

### Planejamento
`get_planning_context` → proposta JSON → `validate_planning_proposal` (guarda a proposta válida) → PR no repositório
coordenador com `planning/proposals/<id>.json` → a tarefa de planejamento é entregue com `planning_proposal_id` e
passa pelas mesmas duas verificações → `.github/workflows/planning.yml` valida no PR e, depois do merge, roda
`--apply`, que hoje só reporta `pending_decision`.

## Código

| Caminho | Papel |
|---|---|
| `src/worker.js` | entrada pública, OAuth, encaminhamento |
| `src/coordinator-do.js` | Durable Object |
| `src/app.js` | rotas dentro do Durable Object |
| `src/mcp/server.js` | protocolo MCP e ferramentas |
| `src/services/*.js` | regras de negócio (síncronas, dentro de transação) |
| `src/auth/google-oidc.js` | OIDC com Web Crypto |
| `src/github/read-source.js` | catálogo: seed ou GitHub somente leitura |
| `src/github/write-adapter.js` | escrita em forks principais: sempre recusada a participantes; merge/apply pendentes |
| `src/github/provisioner.js` | repositórios de trabalho: interface; `DisabledProvisioner` até o portão V-1..V-8 |
| `src/github/webhooks.js` | webhooks do GitHub App (HMAC, dedupe por delivery) |
| `src/services/workspace.js` | ciclo de vida do repositório de trabalho, credencial, integração, revogação, limpeza |
| `tools/git-credential-gta6.mjs` | credential helper do participante |
| `tools/integrate-workspace.mjs` | passo confiável de integração (roda no Actions) |
| `src/schema/*` | schemas canônicos e validador |
| `src/store/*` | interface de store, migrations |
| `seed/*.json` | catálogo inicial (10 desafios) e roadmap |
| `tools/build.mjs` | gera `src/generated/seed.js`, `schemas/*.json`, `public/onboarding.html` |
| `tools/validate-planning.mjs` | validação/aplicação usada pela GitHub Action |
| `test/*.test.js` | testes (Node 24, `node:test`, SQLite via `node:sqlite`) |

O mesmo código de `src/` roda no Worker e nos testes: só usa APIs Web (`fetch`, `crypto.subtle`, `Request`,
`Response`). O teste `test/build.test.js` falha se algo em `src/` importar módulos `node:`.
