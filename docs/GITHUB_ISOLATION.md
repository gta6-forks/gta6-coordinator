# Isolamento de escrita no GitHub: repositório de trabalho por reserva

Decisão do proprietário em 2026-11-21. Este documento descreve o desenho, o que já foi conferido na documentação
oficial do GitHub, o que ainda precisa ser validado na API real antes de ligar o provisionamento automático, e os
riscos que o desenho não elimina.

## 1. Decisão

- Os **cinco forks principais** são repositórios de integração e guardam as Issues centrais.
- Cada **reserva** de tarefa executável ganha um **repositório de trabalho privado e isolado** no GitHub.
- O participante (Google ou **anônimo, sem conta GitHub**) recebe uma credencial temporária que escreve **só nesse
  repositório**, e usa `git clone`/`pull`/`push` **nativos, direto no GitHub**. Não há proxy Git, não há Cloudflare
  Containers e o push não é substituído por uma API do MCP.
- O **Cloudflare Worker** controla identidade, reserva de 24 h, provisionamento, autorização, auditoria e webhooks.
- Um **GitHub App** faz as operações privilegiadas. As credenciais dele (App ID + chave privada, tokens de outras
  instalações ou repositórios) **nunca** chegam aos participantes.
- Ao concluir, um **serviço confiável** integra os commits numa branch de tarefa do fork principal e abre o PR ligado
  à Issue original. O merge na `main` só acontece depois da revisão (duas verificações + CI).
- O acesso é revogado no fim, na expiração, no abandono ou no cancelamento.

O que **não** se afirma: tokens do GitHub não são restritos por branch. A credencial do participante dá escrita no
repositório de trabalho inteiro (todas as branches dele). O isolamento é **por repositório**.

## 2. O que foi conferido na documentação oficial (2026-11-21)

Fonte: docs.github.com. Não foi criado nada no GitHub.

| # | Afirmação | Resultado | Consequência no desenho |
|---|---|---|---|
| 1 | Token de instalação expira em 1 h | Confirmado ("will expire after 1 hour"); não há parâmetro de expiração | A credencial não cobre as 24 h: o *credential helper* pede um token novo ao Worker quando o git precisa |
| 2 | Token pode ser restrito a repositórios e a um subconjunto de permissões | Confirmado (`repositories`/`repository_ids`, até 500; `permissions`) | Token do participante = 1 repositório, `contents: write` (+ `metadata: read` implícito) |
| 3 | Git por HTTPS com `x-access-token:<token>` | Confirmado (exige permissão Contents) | Push nativo funciona sem conta GitHub do participante |
| 4 | Revogação antecipada `DELETE /installation/token` | Confirmado, chamada feita com o próprio token | Ver V-6: o formato novo dos tokens pode afetar isso; a revogação efetiva usa arquivamento do repositório |
| 5 | Sem escopo por branch | Correto na prática (permissões são por repositório) | Isolamento por repositório; não prometer branch |
| 6 | Criar repositório na org com token de instalação | `POST /orgs/{org}/repos` exige **"Repository creation": write** (ou Administration). "Your app is automatically given access to repositories it creates." | Pedir "Repository creation"; repos criados entram na instalação mesmo com "Only select repositories" |
| 7 | `.github/workflows/` exige permissão Workflows | Documentado como exigência para editar esses arquivos (a doc não diz literalmente que o push é rejeitado) | Token do participante sem Workflows; o integrador também recusa mudanças nesse caminho |
| 8 | PR entre repositórios só na mesma rede de forks | Documentado no campo `head` ("cross-repository pull requests in the same network") | Repositório de trabalho criado do zero não é fork: a integração copia o commit para uma branch do fork principal e abre o PR **dentro** dele |
| 9 | Forks | Fork na mesma org **é possível**; fork de repo público é público; não dá para fazer fork de repo privado numa org Free | Usar fork como repositório de trabalho exigiria fork público (vaza o trabalho em andamento) ou plano pago: não usado |
| 10 | Limites de API | 5.000 req/h por instalação (escala até 12.500); secundário: 80 requisições que criam conteúdo por minuto e 500 por hora; 6 pushes/min por repositório recomendados; sem limite documentado de quantidade de repositórios | Fila serial de criação, ~1 s entre POSTs, backoff em 403/429; cota própria de repositórios de trabalho ativos |
| 11 | Plano Free | Repositórios privados ilimitados; Actions em repo privado consome crédito incluído (US$ 12/mês em org Free) | Desligar Actions nos repositórios de trabalho; o integrador roda no repositório coordenador |
| 12 | Rulesets / push rulesets | Em org Free, rulesets só em repositórios **públicos**; push rulesets (bloquear caminho, extensão, tamanho) só em repositórios **privados/internos** em planos pagos | Em org Free não há bloqueio de conteúdo no próprio push: a barreira é o integrador (varredura antes de qualquer coisa chegar ao fork principal) |
| 13 | Arquivar torna o repositório somente leitura | Confirmado; `PATCH` com `archived` exige Administration: write | Revogação imediata = arquivar (do lado do backend) |
| 14 | Apagar repositório | Exige Administration: write; política da org pode bloquear (403) | Limpeza depois da retenção, pelo backend |
| 15 | Chave do App | PEM PKCS#1; JWT RS256, `exp` no máximo 10 min, `iat` 60 s no passado | Converter para PKCS#8 para Web Crypto no Worker |
| 16 | Webhooks | `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256 hex | Implementado em `src/github/webhooks.js` |

## 3. Bloqueios e como o desenho os contorna sem enfraquecer o isolamento

1. **Workers não executam `git`, e Containers estão fora.** Semear o repositório de trabalho e integrar commits no
   fork principal precisam de git. Solução: o **integrador** é um workflow do GitHub Actions no repositório
   coordenador (`.github/workflows/workspace-integrate.yml` + `tools/integrate-workspace.mjs`), disparado pelo Worker
   via `repository_dispatch`. Ele usa um token do App restrito aos dois repositórios envolvidos. O participante
   continua com push nativo direto no GitHub.
2. **Token de 1 h × reserva de 24 h.** O participante configura um *git credential helper*
   (`tools/git-credential-gta6.mjs`) que chama `POST /api/git/credential` com o token do coordenador. O Worker só
   devolve um token novo se a reserva estiver ativa e o caminho pedido for exatamente o repositório de trabalho dessa
   reserva. Limite de 60 credenciais/h por workspace.
3. **Revogação.** Um token já entregue vale até expirar (no máximo 1 h). Para cortar a escrita na hora, o backend
   **arquiva** o repositório de trabalho (somente leitura para todos) e para de emitir tokens; depois da retenção, apaga.
   Se a revogação por `DELETE /installation/token` funcionar com o formato novo (V-6), ela vira uma camada a mais.
4. **PR cross-repo impossível.** Resolvido como pedido: o integrador faz *fast-forward* da branch `task/<issue>` do
   fork principal até o commit entregue (mesmo SHA, sem reescrever) e abre o PR dentro do fork, com `Refs` para a
   Issue original. Se a branch de tarefa andou, o resultado é `conflict` e o participante faz pull, merge e reenvia.
5. **Sem push rulesets em org Free.** O integrador recusa extensões de dados do jogo, `.github/workflows/`,
   `game-files/` e arquivos acima de 5 MB **antes** de qualquer push no fork principal. Resultado
   `forbidden_content` revoga o acesso na hora, cancela a reserva e agenda a exclusão imediata do repositório.
   Com GitHub Team, adicionar push rulesets na org como primeira barreira (P-11).
6. **Permissões do App.** O App precisa de: Contents (write), Metadata (read), Pull requests (write),
   Repository creation (write) e Administration (write) para arquivar, apagar e desligar Actions. Administration
   **nunca** entra no token do participante: o token dele é pedido com `permissions: { contents: "write" }` e
   `repositories: [<repo de trabalho>]`.

## 3b. Semeamento do repositório de trabalho (2026-11-21)

O teste ponta a ponta em produção mostrou que o participante não consegue enviar o histórico do fork para o
repositório de trabalho vazio: 4 dos 5 forks têm `.github/workflows/` e o token do participante (só `contents`) é
recusado, como manda o V-3. Correção: depois de criar o repositório, o provisionador dispara `seed-workspace`; o job
`seed` do workflow do coordenador copia a branch de tarefa do fork (leitura pública) para o repositório de trabalho com
um token de **um** repositório e `contents`+`workflows` write, e avisa o Worker (`outcome: seeded`, mesmo SHA de
`base_sha`). Só então o workspace fica `ready` e o participante recebe credencial. Isso exige a permissão **Workflows
(write)** no App; ela nunca entra no token do participante.

## 4. Ciclo de vida do repositório de trabalho

```
reserva ativa ──get_workspace──▶ requested ──provision──▶ ready ──submit_completion(workspace_id)──▶ integrating
                                                            ▲                                          │
                                         conflict / error ──┘                         integrated ◀─────┤
                                                                                         │     forbidden_content
                                                                                         ▼             ▼
                      reserva encerrada (concluída, liberada, expirada, cancelada) ──▶ revoking ──▶ revoked ──retenção──▶ deleted
```

- `provision`: cria `WORKSPACE_ORG/w-<id>` privado e vazio, desliga Actions, garante a branch `task/<issue>` no fork
  principal (via API, token só do fork) e grava `base_sha`. O participante clona a branch pública do fork (leitura,
  sem credencial) e faz push no repositório de trabalho.
- Toda transição é decidida no Durable Object; `reconcileWorkspaces` (depois de cada chamada MCP e no cron) faz o
  GitHub chegar ao estado do banco. Pode ser repetido sem efeito colateral.
- Idempotência: um workspace por reserva (`UNIQUE(reservation_id)`); `get_workspace` repetido devolve o mesmo
  repositório; callbacks duplicados do integrador são ignorados; entregas de webhook são deduplicadas por
  `X-GitHub-Delivery`.

## 5. Riscos que o desenho não elimina

- **Cópias não se revogam.** Repositório privado não impede que o participante guarde o que clonou. Por isso o
  repositório de trabalho só recebe código aberto do projeto e o trabalho do próprio participante; nunca dados
  privados de terceiros nem segredos.
- **Dado proprietário enviado pelo participante.** Alguém pode subir dados do jogo no próprio repositório de trabalho.
  Barreiras: varredura do integrador (nada chega ao fork principal), exclusão imediata no `forbidden_content`,
  evento de auditoria para revisão humana, e retenção curta para o resto. Em org Free não há bloqueio no momento do
  push (item 12).
- **Abuso de cota.** Cada reserva pode criar um repositório. Mitigações: uma reserva por participante, limite de
  cadastro anônimo, fila serial de criação, retenção curta, limite de workspaces ativos (P-12).
- **Token vazado pelo participante.** Vale só para o repositório dele e por no máximo 1 h; o arquivamento corta na hora.
- **Autor dos commits.** Commits de anônimos não têm conta GitHub ligada; o push aparece como o App. A atribuição fica
  no log de auditoria do coordenador.

## 6. Portão de validação antes de ligar o provisionamento (V-1 a V-8)

`GitHubAppProvisioner` está implementado e testado contra uma API simulada. Ele só liga com
`WORKSPACE_PROVISIONER=github-app`. Antes disso, rodar `node tools/github-gate.mjs` numa **org de teste**, com um App
de teste (manifesto: `docs/github-app-manifest.json`). O script cria e apaga repositórios temporários e checa:

| Gate | Validar |
|---|---|
| V-1 | `POST /orgs/{org}/repos` com token de instalação e permissão "Repository creation" cria repo privado, e ele entra na instalação "Only select repositories" |
| V-2 | Token pedido com `repositories: [w-x]` e `permissions: {contents: write}` faz clone e push em `w-x` e **falha** (403) em qualquer outro repo da org, inclusive nos forks principais |
| V-3 | Push que altera `.github/workflows/` com esse token é recusado |
| V-4 | `PATCH archived: true` bloqueia push imediatamente, inclusive com um token ainda válido |
| V-5 | `PUT /repos/{o}/{r}/actions/permissions {enabled:false}` desliga Actions no repo de trabalho |
| V-6 | `DELETE /installation/token` revoga o token no formato novo (`ghs_…` stateless, desde 2026-04-27 segundo a documentação) |
| V-7 | O integrador (Actions) consegue buscar um SHA do repo de trabalho e fazer fast-forward na branch de tarefa do fork principal, e abrir o PR no fork |
| V-8 | Medir os limites secundários reais criando 20 repositórios em sequência com 1 s de intervalo |

Resultado de cada gate vai neste documento, com data.

**2026-11-21, org `gta6-work`, App 5868568, instalação "Only select repositories" (`_anchor`, `gate-other`): V-1 FAIL.**
O `POST /orgs/gta6-work/repos` com token de instalação **cria** o repositório, mas ele **não** entra numa instalação
"Only select repositories": pedir token para ele dá 422 ("does not exist or is not accessible to the parent
installation"). A afirmação 6 da tabela vale só para instalação "All repositories". Correção adotada: a org de
trabalho é dedicada (só repositórios de trabalho + `_anchor`), então a instalação nela usa **All repositories**; o
isolamento continua no token, que sempre nomeia um único repositório. Os forks principais ficam em outra instalação.

**2026-11-21, mesma org, instalação "All repositories": V-1, V-2, V-3, V-4, V-5, V-6 e V-8 PASS** (5 repositórios em
18,8 s com 1 s de intervalo, sem limite secundário). **V-7 PASS** (2026-11-21, `tools/integrate-workspace.mjs` contra `gta6-work` → `gta6-forks/rpf9-explorer`: mesmo SHA na
branch de tarefa, PR aberto e depois fechado). Corrigidos no caminho: colisão de ref local com branches `task/*` e
vazamento do cabeçalho de autenticação em mensagens de erro do git. Webhook do App verificado: entrega com 200 depois de sincronizar
`GITHUB_WEBHOOK_SECRET`.

Regra de implementação: **nenhum token com escrita cobre mais de um repositório** (`GitHubAppClient` recusa). O
integrador emite dois tokens: `contents:read` no repositório de trabalho e `contents`+`pull_requests` write só no fork.
Com o prazo de 24 h, o repositório de uma reserva expirada é arquivado e preservado; o próximo participante recebe
outro repositório.
