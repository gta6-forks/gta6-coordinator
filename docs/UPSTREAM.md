# Reconciliação com os repositórios originais (upstream)

Regra do proprietário (2026-11-22): antes de criar, priorizar, distribuir ou reabrir uma missão, o planejador verifica o
repositório **original**. Os upstreams evoluem em paralelo e o estoque de tarefas pode ficar resolvido, obsoleto ou
precisar ser redefinido. Código em `src/services/upstream.js` e `src/github/upstream-reader.js`, testes em `test/upstream.test.js`.

## O que roda

| Quando | O quê |
|---|---|
| Cron (`*/30`), respeitando `UPSTREAM_CHECK_MINUTES` | HEAD de cada upstream (sha, data, branch acompanhada) e as fontes de cada tarefa em estoque ou reservada |
| Antes de `claim_next_task` / `claim_task` | Rechecagem dos upstreams envolvidos quando o snapshot tem mais de `UPSTREAM_FRESH_MINUTES` (limite de tempo `UPSTREAM_PRECHECK_TIMEOUT_MS`) |
| Antes de `get_planning_context` / `validate_planning_proposal` | Mesma rechecagem. O contexto do planejador traz `upstream` com HEAD, última checagem, status e evidências por tarefa |
| `check_upstream` (Google, 1 vez a cada 5 min) | Rechecagem forçada sob demanda |

Sinais por tarefa, sempre a partir das **fontes da própria tarefa** e nunca de título ou palavra-chave:

| Sinal | Evidência registrada | Status automático |
|---|---|---|
| PR de origem mergeado | URL, `merged_at`, `merge_commit_sha` | `resolved_upstream` (provisório) |
| Issue de origem fechada como concluída | commit que fechou, PRs ligados (timeline) | `resolved_upstream` (provisório) |
| Issue fechada `not_planned` / `duplicate`, ou PR fechado sem merge | issue/PR, data | `obsolete` (provisório) |
| Seção citada do arquivo sumiu, arquivo removido ou issue apagada | arquivo@sha, heading ausente | `needs_replan` |
| Arquivo citado mudou desde a linha de base, ou issue atualizada | commits que tocaram o caminho (até 10), `updated_at` | `needs_review` |
| Nada mudou | sha de base | `valid` |

A linha de base de um arquivo é o `retrieved_at` da fonte. Na falta dele vale `UPSTREAM_BASELINE_SINCE`, e na falta
dos dois, a primeira observação.

## Veredito do planejador (`record_upstream_verdict`)

O status automático só é **provisório**. A confirmação vem de um planejador (login Google), que precisa:

- citar o HEAD atual (`basis_sha`), observado nos últimos `UPSTREAM_FRESH_MINUTES` (senão: `upstream_moved` / `upstream_check_required`);
- responder **todos** os critérios de aceite com `yes|partial|no|unknown`. `yes` e `partial` exigem evidência de commit, PR ou arquivo; título ou issue sozinhos não valem;
- `resolved_upstream` = todos `yes`; `partially_met` = alguns; `valid` = nenhum; `obsolete` e `needs_replan` exigem justificativa.

O veredito vale enquanto o upstream não produzir sinal novo (impressão digital dos sinais) e por no máximo
`UPSTREAM_VERDICT_MAX_DAYS`. Depois disso a tarefa volta ao status automático com `revalidation_required`. Os vereditos
ficam numa tabela só de inclusão (`upstream_verdicts`), sem edição nem remoção.

## O que o mecanismo nunca faz

- Não muda `tasks.status`, não fecha issue, não cancela tarefa. Encerrar ou redefinir continua sendo uma proposta de
  planejamento revisada (`close_issue` / `create_issue`).
- Não mexe em reserva ativa de terceiros: registra `upstream.reserved_task_flagged`, e quem está com a tarefa vê o aviso em `whoami` e `get_task`.
- Não apaga histórico: eventos `upstream.*` no log, vereditos só de inclusão, e um snapshot com falha não sobrescreve o último bom.
- Não escreve no GitHub (só GET).

## Modos (`UPSTREAM_RECONCILIATION`)

| Modo | Efeito |
|---|---|
| `off` | Nada roda |
| `report` (**padrão**) | Checa, registra e mostra avisos, mas **não bloqueia** nenhuma distribuição |
| `enforce_evidence` | Não distribui `resolved_upstream`, `obsolete`, `partially_met` e `needs_replan`. Dependência resolvida no upstream conta como satisfeita |
| `enforce` | Também segura `needs_review`, `unchecked` e upstream sem checagem bem-sucedida há mais de `UPSTREAM_MAX_STALENESS_MINUTES` (fail-closed) |

Subir para `enforce_evidence` ou `enforce` **desativa missões** e depende de autorização do proprietário.

## Planejamento e estoque

- `validate_planning_proposal` recusa `set_priority`, `set_readiness`, `add_dependency` e `replaces_draft` sobre tarefa `resolved_upstream`/`obsolete` (a saída é fechar a tarefa).
  Também recusa `ready` para `partially_met`/`needs_replan` (é preciso redefinir o escopo) e avisa sobre `needs_review`/`unchecked`.
- Limite de estoque: no máximo `UPSTREAM_MAX_STOCK_PER_REPO` tarefas operacionais `open` e `ready` por repositório original.
  Uma proposta que passe do limite é recusada.

## Frequência, erros e rate limit

- Recomendado: cron a cada 30 min, rechecagem sob demanda depois de 15 min, limite de staleness de 6 h. Com 5 upstreams e
  cerca de 12 tarefas, uma rodada gasta uns 30 requests. Com ETag quase tudo volta 304, que não consome a cota quando autenticado.
- Token de leitura: `GITHUB_READ_TOKEN`, senão o token da instalação do App (só leitura), senão anônimo (60/h).
- Rate limit: para antes de `x-ratelimit-remaining < UPSTREAM_MIN_RATE_REMAINING`. Com 403/429 guarda
  `upstream_backoff_until` (reset ou `retry-after`) e as rodadas seguintes esperam. Cada rodada tem teto de
  `UPSTREAM_MAX_REQUESTS_PER_RUN` e checa primeiro as tarefas mais antigas, então rodadas parciais vão alternando as tarefas.
- 5xx ou erro de rede num repo: `consecutive_failures++`, backoff exponencial de 5 min até 2 h, e o último snapshot bom é mantido.
- Branch acompanhada: `UPSTREAM_BRANCHES` (`realdody/americas-recomp=xbox-series`, porque lá a `main` só tem o "Initial commit").
