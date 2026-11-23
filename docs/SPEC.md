# SPEC — GTA 6 Explorer Coordinator (MVP 0.1)

Data: 2026-11-21. Estado: MVP implementado e testado localmente; **não implantado**.

Cada item tem um identificador. **D-** é decidido (e implementado, salvo indicação). **P-** é pendente: a interface
existe, o comportamento seguro está travado por teste, a decisão final é do proprietário.

---

## 1. Escopo

O coordenador distribui trabalho de pesquisa e engenharia, feito por pessoas com agentes de IA, entre cinco
projetos técnicos abertos: **Leonida**, **Xbox2Windows**, **ScarlettX**, **rpf9-explorer** e **americas-recomp**
(branch `xbox-series`). Ele não hospeda código, não executa builds e não guarda nenhum dado do jogo.

### Proibições permanentes

- **D-RULE-1** Nenhum build, executável, asset, shader, chave ou arquivo proprietário do jogo é baixado,
  armazenado, aceito como entrega ou distribuído. Entregas com extensões de dados do jogo são recusadas
  (`src/services/review.js`, `FORBIDDEN_EXT`), e `game_data_in_deliverables` precisa ser `false`.
- **D-RULE-2** Nada de descriptografia ou contorno de proteção. Um desafio que dependa disso não entra no catálogo
  (por exemplo, a decodificação do diretório RPF9, que o README do Leonida liga a uma tabela de conteúdo cifrada).
- **D-RULE-3** Participantes nunca recebem escrita nos forks principais nem nos upstreams. A única credencial que
  sai do backend é um token de instalação restrito a **um** repositório de trabalho isolado, só enquanto a reserva
  está ativa (D-GIT). As credenciais do GitHub App nunca saem do backend.
- **D-RULE-4** Os cinco clones upstream no workspace não são alterados pelo coordenador.

---

## 2. Decidido

### Arquitetura

- **D-ARCH-1** Cinco forks principais (um por projeto) são os repositórios de integração e guardam as Issues
  centrais; um repositório coordenador separado guarda planejamento e o integrador. Os forks **ainda não existem**:
  `fork_repo` é `null` em todas as tarefas até serem criados (ver P-5).
- **D-ARCH-2** O GitHub é a fonte de verdade de issues, subissues, dependências, branches, PRs e planejamento.
  O coordenador mantém só o estado de distribuição (reservas, revisões, perfis) e um espelho do catálogo.
- **D-ARCH-3** O MCP coordena a distribuição e os perfis. O participante conecta o Claude Code (ou outro cliente MCP)
  por HTTP com um token bearer.
- **D-ARCH-4** IDs de tarefa são `dono/repo#número` (issue ou PR no GitHub). Para itens ainda sem issue usa-se
  `draft:dono/repo/slug` (nunca distribuído). Tarefas geradas pelo coordenador usam `local:…` (verificação e
  replanejamento).

### Infraestrutura Cloudflare

- **D-INFRA-1** Um Cloudflare Worker (`src/worker.js`) é o ponto de entrada público. Não há servidor Node persistente.
- **D-INFRA-2** O estado de coordenação vive em **um Durable Object com armazenamento SQLite** (`Coordinator`,
  instância `global`). Escolhido em vez de D1 porque:
  1. a reserva concorrente exige escrita atômica com leitura prévia (elegibilidade + inserção). O Durable Object
     processa uma requisição por vez e oferece `transactionSync`; D1 não tem transações interativas, só `batch`;
  2. índices únicos parciais (`one_active_reservation_per_task`, `one_active_reservation_per_participant`) dão uma
     segunda barreira no próprio banco;
  3. o volume esperado (dezenas a centenas de participantes) cabe com folga numa instância.
  D1 continua opção para leituras analíticas ou réplicas, se um dia fizer falta.
- **D-INFRA-3** **Workers KV** (`OAUTH_KV`) guarda o `state`/PKCE/nonce do OAuth com TTL de 10 minutos e o cache
  do JWKS do Google (1 hora). KV é eventualmente consistente; por isso o limite de cadastros anônimos fica no
  Durable Object, não no KV.
- **D-INFRA-4** **R2 não é usado no MVP.** O Git do GitHub é o armazenamento de entregas. Código, conhecimento, testes e artefatos vão no Git (D-DELIV-1). R2 só
  entraria para artefatos grandes de verificação, e nunca para dados do jogo.
- **D-INFRA-5** A landing page e o onboarding são servidos por **Workers Static Assets** (`public/`), com CSP em
  `public/_headers`. `public/onboarding.html` é gerado de `docs/ONBOARDING.md` por `npm run build`.
- **D-INFRA-6** Um Cron Trigger (a cada 30 min) ressincroniza o catálogo a partir da fonte configurada.
- **D-UPSTREAM-1** (2026-11-22, regra prioritária do proprietário) O planejador reconcilia com os repositórios originais
  antes de criar, priorizar, distribuir ou reabrir missões: HEAD sha + última checagem por upstream, evidências por tarefa,
  veredito por critério de aceite, sem fechar tarefas nem tocar reservas automaticamente. Modo padrão `report`;
  bloquear exige autorização. Detalhes em `docs/UPSTREAM.md`.
- **D-INFRA-7** Migrations do SQLite são versionadas em `src/store/migrations.js` e aplicadas no construtor do
  Durable Object. A classe é declarada em `wrangler.jsonc` com `new_sqlite_classes`.
- **D-INFRA-8** Nenhum deploy é feito sem credenciais e autorização do proprietário. `wrangler.jsonc` tem
  placeholders (`REPLACE_WITH_…`) para IDs de KV e hostname.

### Identidade no coordenador (não é GitHub)

- **D-AUTH-1** Dois tipos de participante:
  - **google**: tarefas estratégicas (planejar, verificar) e operacionais;
  - **anonymous**: só operacionais.
- **D-AUTH-2** Login Google por **OAuth 2.0 / OpenID Connect, authorization code com PKCE (S256), `state` de uso
  único e `nonce`**. O cliente OAuth pertence a um projeto do Google Cloud administrado pela conta do proprietário (Di).
  Cada participante entra com a **própria** conta; a sessão pessoal do proprietário nunca é usada como identidade
  de ninguém.
- **D-AUTH-3** O ID token é verificado no Worker: assinatura RS256 contra o JWKS do Google, `iss`, `aud` igual ao
  client ID, `exp`, `iat`, `nonce` e `email_verified`. Restrição opcional por domínio (`GOOGLE_ALLOWED_DOMAIN`).
- **D-AUTH-4** `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` são secrets do Worker. Sem eles, o login Google fica
  desligado (HTTP 503) e a landing mostra "não configurado". Nenhum secret está no código.
- **D-AUTH-5** Anônimo: `POST /auth/anonymous` cria o participante e devolve um token **persistente** uma única vez.
  Limite de 10 cadastros por hora por rede (hash do IP com pepper).
- **D-AUTH-6** Tokens do coordenador (`g6a_…` anônimo, `g6g_…` Google) têm 256 bits aleatórios e são guardados só
  como SHA-256 com pepper (`TOKEN_PEPPER`). Podem ser revogados.
- **D-AUTH-7** O login MCP é por cabeçalho `Authorization: Bearer`. O fluxo de autorização OAuth nativo do MCP
  (descoberta de authorization server pelo cliente) fica para depois (P-7).

### Tarefas

- **D-TASK-1** Schema em `schemas/task.schema.json` (fonte: `src/schema/schemas.js`).
- **D-TASK-2** Executável: issue simples ou subissue. Issue pai de agrupamento (`kind: group`) nunca é distribuída.
- **D-TASK-3** Campos de filtragem: `repo`, `type` (strategic/operational), `role` (execute/plan/verify),
  `difficulty`, `priority`, `readiness`, `milestone`, `os`, `gpu`, `needs_game_files` por fase.
- **D-TASK-4** Instruções em Markdown (`instructions_md`) e requisitos em JSON estruturado, **separando
  implementação de validação**, cada fase com `required` / `optional` / `suggested`. Cada requisito tem `kind`,
  `value`, `source` e `confidence` (`confirmed`, `inferred`, `unspecified`).
- **D-TASK-5** Só requisitos `required` com confiança `confirmed` ou `inferred` são exigidos do perfil; os
  `unspecified` são informativos. Requisito de arquivos do jogo `yes` exige `has_own_game_copy`; `unknown` exige
  também `accept_unknown_requirements`.
- **D-TASK-6** Dificuldade sempre marcada com `difficulty_source` (`estimate` ou `maintainer`).
- **D-TASK-7** Critérios de aceitação são texto com fonte e confiança (`acceptance[]`).
- **D-TASK-8** Só tarefas desbloqueadas são servidas: todas as dependências (inclusive de outro repositório) com
  `status = done` ou `state = closed`. Dependência desconhecida mantém a tarefa bloqueada. Ciclos são detectados no
  sync e na validação de planejamento.

### Distribuição e reservas

- **D-RES-1** **Prazo absoluto de 24 h a partir da atribuição, sem renovação nem extensão** (decisão de 2026-11-21).
  `RESERVATION_TTL_HOURS` só pode encurtar. Ao vencer: a reserva vira `expired`; entrega, verificação e emissão de
  credencial passam a ser recusadas (HTTP 410 `reservation_expired`), inclusive se a varredura ainda não rodou; o
  repositório de trabalho é arquivado (escrita cortada) e **preservado** para auditoria, com logs e commits; a tarefa
  volta para a fila e o próximo participante recebe um repositório isolado **novo**. Integração que termina depois do
  prazo é rejeitada (`rejected_late`).
- **D-RES-1b** Abandono: quem deixou uma tarefa expirar não pode pegá-la de novo por 72 h (`RECLAIM_COOLDOWN_HOURS`);
  com 3 expirações em 7 dias (`MAX_EXPIRATIONS_PER_WEEK`), novas reservas ficam pausadas até a mais antiga sair da janela.
- **D-RES-2** Uma reserva ativa por tarefa e uma por participante ("uma tarefa por vez").
- **D-RES-3** Modo contínuo: o cliente chama `claim_next_task` de novo depois de cada entrega. Não há empurrão do
  servidor.
- **D-RES-4** Idempotência por `idempotency_key` em reserva, entrega e verificação. Reusar a chave em outra operação
  é erro.
- **D-RES-5** Ordem de escolha: prioridade (p0 primeiro), depois dificuldade (menor primeiro), depois id.
- **D-RES-6** Liberação explícita com motivo (`release_reservation`), registrada no log de eventos.

### Entregas e revisão

- **D-DELIV-1** Código, conhecimento em Markdown, testes e artefatos vão no Git. A conclusão é um JSON no MCP
  (`schemas/completion.schema.json`) com PR, commit exato, comandos de validação com exit code e ambiente.
- **D-REV-1** Caminho principal: o executor entrega pelo repositório de trabalho (`workspace_id`); o integrador abre o
  PR no fork principal e só então nascem as **duas** tarefas de verificação (`local:verify/<review>/1|2`).
  Caminho alternativo (quem tem conta GitHub e prefere): `pr_url` de um PR próprio para o fork principal; as
  verificações nascem na hora.
- **D-REV-2** Verificação: só Google; nunca o executor; nunca a mesma pessoa nos dois slots; precisa citar exatamente
  o `commit_sha` revisado. Commit novo exige nova entrega.
- **D-REV-3** Qualquer reprovação (ou CI com falha) cancela o slot restante, marca a tarefa `needs_replan` e cria
  uma tarefa estratégica de replanejamento com o feedback.
- **D-REV-4** Duas aprovações + CI verde (webhook `/api/ci` com secret compartilhado) levam a revisão a
  `ready_to_merge` e registram um **merge intent**. O merge em si depende de P-4.

### Planejamento

- **D-PLAN-1** Planejadores (Google) consultam roadmap, marcos, todas as tarefas, revisões, progresso e falhas
  (`get_planning_context`).
- **D-PLAN-2** Mudanças são propostas em JSON (`schemas/planning-proposal.schema.json`): `create_issue` (com
  `replaces_draft`), `close_issue`, `set_priority`, `set_readiness`, `add_dependency`, `remove_dependency`,
  `add_subissue`, `roadmap_change`, `set_objective`.
- **D-PLAN-3** A proposta é validada no MCP e de novo na GitHub Action (`tools/validate-planning.mjs`), que também
  confere duas verificações e o portão humano. Validação inclui IDs existentes, ciclos, subissue só sob grupo, e
  rascunho só vira pronto via `create_issue`.
- **D-PLAN-4** O objetivo final e marcos `protected` só mudam com autorização humana explícita
  (`requires_human_authorization`).
- **D-PLAN-5** A Action nunca contorna proteções de branch e não aplica nada (`--apply` só reporta).
- **D-PLAN-6** (2026-11-21, decisão do proprietário: caminho 1) Aplicação pelo Worker: quando o PR de planejamento no
  repositório coordenador recebe merge depois das duas verificações (webhook `pull_request` merged), o Worker lê
  `planning/proposals/*.json` no commit de merge, valida de novo contra o catálogo e aplica: `create_issue` vira issue
  `gta6-task` no fork principal (marcador oculto por proposta/ref, idempotente); as demais operações editam o bloco
  `gta6-task` da issue no fork ou gravam um *override* para tarefas do seed; `replaces_draft` fecha o rascunho e troca a
  dependência dos dependentes. `roadmap_change`/`set_objective` só são registrados para o proprietário. Cada proposta é
  aplicada no máximo uma vez. Catálogo = seed + issues `gta6-task` dos forks (`TASK_SOURCE=seed+github`). O App precisa
  de **Issues (write)**; todo token de escrita continua cobrindo um único repositório. Repetição manual:
  `POST /api/planning/apply` com o secret do integrador.

### GitHub e isolamento de escrita (decidido em 2026-11-21; detalhes em `docs/GITHUB_ISOLATION.md`)

- **D-GIT-1** Um **repositório de trabalho privado por reserva** de tarefa executável (ou de planejamento), criado
  pelo GitHub App na org de trabalho (`WORKSPACE_ORG`). `get_workspace` é idempotente.
- **D-GIT-2** O participante, Google ou anônimo **sem conta GitHub**, usa `git clone`/`pull`/`push` nativos direto no
  GitHub. A credencial chega pelo *credential helper* (`tools/git-credential-gta6.mjs` → `POST /api/git/credential`),
  nunca por saída de ferramenta MCP.
- **D-GIT-3** A credencial é um token de instalação com `repositories: [repo de trabalho]` e
  `permissions: {contents: write}`, que expira em no máximo 1 h e é renovado sob demanda enquanto a reserva estiver
  ativa. **Não é restrito por branch** (o GitHub não oferece isso).
- **D-GIT-4** Sem proxy Git, sem Cloudflare Containers, sem push por API do MCP.
- **D-GIT-5** O GitHub App faz as operações privilegiadas (criar, arquivar e apagar repositório de trabalho, desligar
  Actions, integrar, abrir PR). Suas credenciais ficam em secrets do Worker e do repositório coordenador.
- **D-GIT-6** Integração por serviço confiável (workflow do Actions no repositório coordenador): fast-forward da
  branch `task/<issue>` do fork principal até o commit entregue (mesmo SHA), varredura de conteúdo antes de qualquer
  push, PR dentro do fork com `Refs` para a Issue. Conflito devolve o workspace ao participante.
- **D-GIT-7** Revogação no fim, expiração, abandono (expiração), liberação ou cancelamento: parar de emitir tokens e
  **arquivar** o repositório (somente leitura imediata); apagar depois de `WORKSPACE_RETENTION_DAYS` (padrão 7).
  `forbidden_content` apaga na hora.
- **D-GIT-8** Verificadores não recebem repositório de trabalho: fazem checkout do commit integrado no fork principal.
- **D-GIT-9** `GitHubAppProvisioner` está implementado (JWT RS256 com Web Crypto, criação idempotente, Actions
  desligado, branch de tarefa no fork, credencial `contents:write` de um repositório, arquivamento, exclusão,
  dispatch do integrador, retry em limite secundário, espaçamento de 1 s entre criações) e testado contra uma API
  simulada. Ele só liga com `WORKSPACE_PROVISIONER=github-app` e os secrets do App. O portão real é
  `node tools/github-gate.mjs` numa org de teste.
- **D-GIT-10** **Nenhum token com escrita cobre mais de um repositório**, nem do participante nem do backend:
  `GitHubAppClient.installationToken` recusa. A criação de repositório usa um token restrito ao repositório âncora
  vazio (`WORKSPACE_ANCHOR_REPO`); o integrador usa um token de leitura do repositório de trabalho e outro de escrita
  só no fork.

### Métricas (decidido em 2026-11-21)

- **D-MET-1** Leaderboard auditável por participante, derivado só de registros do próprio coordenador: reservadas,
  entregues, aceitas (duas aprovações do mesmo commit + CI), rejeitadas, expiradas, liberadas, PRs merged,
  verificações, commits enviados (webhooks `push` deduplicados por repo+SHA; `null` quando não há webhook),
  mediana atribuição→entrega e taxa de entrega dentro de 24 h (`entregues / (entregues + expiradas)`).
- **D-MET-2** Ranking: aceitas, depois taxa de aceitação, depois PRs merged, depois mediana mais rápida. Volume bruto
  não é pontuação.
- **D-MET-3** Uso de modelo é **opcional e auto-relatado** por `agent_report_usage`: provider, model id, versão,
  tokens de entrada/saída/total, `measurement` (`reported_actual` = contadores do runtime; `estimated`; `unknown`),
  método, fonte e confiança. Estimativa nunca tem confiança alta. Tokens nunca são inferidos de commits. Sem relato,
  aparece como desconhecido. Tudo é marcado `verified_by_coordinator: false`.
- **D-MET-4** Agregados por participante, modelo, tarefa, projeto e total, com histórico diário (`get_metrics`,
  `GET /api/metrics`). A landing mostra esses números ao vivo.
- **D-MET-5** Privacidade: o público só vê um pseudônimo gerado (`public_alias`) e o tipo de conta (Google
  verificada × pseudônimo anônimo). E-mail, nome do Google, IDs internos e IP nunca aparecem.
- **D-MET-6** Antifraude: aceitação exige dois verificadores Google independentes e diferentes do executor;
  aprovações recíprocas repetidas entre dois participantes recebem a marca `reciprocal_approvals`; relatos de uso só
  para tarefas que o participante reservou, até 48 h depois do fim, no máximo 50 por tarefa, com chave idempotente;
  webhooks deduplicados por `X-GitHub-Delivery`; cadastro anônimo limitado por rede.

---

## 3. Pendente (decisão do proprietário)

| ID | Tema | Estado seguro atual | Onde está a interface |
|---|---|---|---|
| **P-1** | **Bloqueio externo**: criar a org de teste e o GitHub App (manifesto em `docs/github-app-manifest.json`) e rodar `tools/github-gate.mjs` | Provisionador implementado, desligado por config | `src/github/provisioner.js` |
| **P-2** | Org de trabalho (nome, plano Free ou Team). Com Team, push rulesets viram a primeira barreira de conteúdo | `WORKSPACE_ORG` vazio | `wrangler.jsonc` |
| **P-3** | Executor de merge na `main` depois da revisão (App com merge via API, merge queue, mantenedor humano) | Só registra merge intent; o merge é humano. A aplicação de planejamento foi decidida (D-PLAN-6) | `src/github/write-adapter.js` |
| **P-4** | Registro do GitHub App (dono, permissões, webhook), guarda da chave privada | Não existe | `docs/DEPLOY.md` §7 |
| **P-5** | Criação dos cinco forks principais e do repositório coordenador; nomes | `fork_repo: null`; `COORDINATOR_REPO` vazio | `seed/tasks.json`, `wrangler.jsonc` |
| **P-6** | ~~Endpoints de subissues e dependências~~ **confirmados na API real em 2026-11-21** (`/sub_issues`, `/dependencies/blocked_by`, campos `parent_issue_url`, `issue_dependencies_summary`). Falta só publicar issues com o rótulo `gta6-task` nos forks | Fonte padrão é o seed | `src/github/read-source.js` |
| **P-7** | Autorização OAuth nativa do MCP (em vez de token colado) | Bearer token | `src/mcp/server.js` |
| **P-8** | Quem aprova mudanças protegidas e como a Action recebe as duas verificações | Variáveis do workflow; apply recusa protegidos | `.github/workflows/planning.yml` |
| **P-9** | Retenção de dados (e-mail, eventos, repositórios de trabalho) e política de privacidade | E-mail só para responsabilização; retenção de workspace 7 dias | `participants`, `WORKSPACE_RETENTION_DAYS` |
| **P-10** | Hostname de produção | Placeholder | `wrangler.jsonc` |
| **P-11** | Limite de workspaces ativos e de criação por dia (cota) | Uma reserva por participante + limite de cadastro anônimo | `src/services/workspace.js` |

Testes que travam o estado seguro: `test/git-safety.test.js` (ninguém escreve nos forks principais pelo MCP; tokens
de ambiente nunca aparecem), `test/workspace.test.js` (credencial só para o próprio repositório de trabalho e só com
reserva ativa; revogação em liberação/expiração/cancelamento; integração com o mesmo SHA; varredura de conteúdo) e
`test/planning.test.js` (Action não aplica nada).

---

## 4. Máquinas de estado

Tarefa (`tasks.status`):

```
open ──submit_completion──▶ in_review ──2 aprovações + CI──▶ approved ──merge webhook──▶ done
  ▲                             │
  │                             └─reprovação / CI falhou──▶ needs_replan  (gera local:plan/replan/<review>)
  └── reserva expirou / liberada (a tarefa nunca saiu de open)
```

Tarefas de verificação: `open → done` (veredito) ou `open → cancelled` (o outro slot reprovou).

Workspace: `requested → ready → integrating → integrated → revoking → revoked → deleted`; `integrating → ready`
(conflito/erro); `integrating → failed` (conteúdo proibido, exclusão imediata). Com workspace, a reserva fica ativa
durante a integração e só é concluída quando o integrador confirma o PR.

Reserva: `active → completed | released | expired | cancelled`.

Revisão: `verifying → awaiting_ci → ready_to_merge → merged`, ou `→ changes_requested`.

---

## 5. Superfície

### MCP (`POST /mcp`, JSON-RPC 2.0, Streamable HTTP com respostas JSON)

`initialize`, `ping`, `tools/list`, `tools/call`. Ferramentas: `whoami`, `set_profile`, `list_tasks`, `get_task`,
`claim_next_task`, `claim_task`, `renew_reservation`, `release_reservation`, `submit_completion`,
`submit_verification`, `get_workspace`, `get_planning_context`, `validate_planning_proposal`, `request_git_access`
(sempre recusa escrita em fork principal/upstream).

### HTTP

| Rota | Quem | Função |
|---|---|---|
| `GET /` , `/onboarding.html` | público | landing e onboarding (static assets) |
| `GET /api/config` | público | login Google ligado?, URL do MCP, TTL |
| `GET /api/tasks` | público | catálogo sem dados pessoais. Responde `{ tasks, counts, reservation_policy }`; `counts` traz o total por status de todo o catálogo, calculado antes do filtro. `?status=open,in_review` (opcional, separado por vírgula) devolve só esses status. Valores aceitos, exatamente e diferenciando maiúsculas: `open`, `in_review`, `needs_replan`, `approved`, `done`, `cancelled`. `ready` é readiness, não status. Valor desconhecido ou vazio (`?status=`, `open,,done`) → 400 `invalid_status_filter` com `details.invalid` e `details.accepted` |
| `POST /auth/anonymous` | público, mesma origem | cria participante anônimo |
| `GET /auth/google/start`, `/auth/google/callback` | público | OIDC |
| `POST /mcp` | token | MCP |
| `POST /api/ci` | secret `X-Coordinator-Secret` | resultado de CI (`success`/`failure`) e `pr_merged` |
| `POST /api/git/credential` | token do coordenador | credential helper: token do repositório de trabalho da reserva ativa |
| `POST /api/integration` | secret `X-Coordinator-Secret` | resultado do integrador (`integrated`, `conflict`, `error`, `forbidden_content`) |
| `POST /api/github/webhook` | HMAC `X-Hub-Signature-256` | `pull_request` merged → tarefa `done`; `push` → auditoria |
| `GET /health` | público | estado e descrição do adaptador de escrita |
| `/internal/*` | só Worker → Durable Object | bloqueado na borda (404) |

Requisições de navegador com `Origin` diferente do host (ou de `ALLOWED_ORIGINS`) são recusadas em `/mcp` e
`/auth/anonymous`.

---

## 6. Riscos conhecidos

- Um único Durable Object é um ponto único de escrita. Aceitável no volume previsto; se crescer, particionar por
  repositório.
- Perfis são autodeclarados. A verificação dupla compensa: quem declara GPU que não tem não passa na verificação.
- Tokens anônimos são portadores: quem tem o token é o participante. Não há recuperação.
- O coordenador confia no webhook de CI pelo secret compartilhado. Com o GitHub App ligado, trocar por checagem do
  status direto na API do GitHub.
- Cópias clonadas de um repositório de trabalho não podem ser revogadas; ver `docs/GITHUB_ISOLATION.md` §5.
