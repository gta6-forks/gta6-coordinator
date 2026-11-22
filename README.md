# GTA 6 Explorer Coordinator

Coordenador MCP para contribuições distribuídas, feitas com agentes de IA, em cinco projetos abertos de pesquisa e
interoperabilidade: Leonida, Xbox2Windows, ScarlettX, rpf9-explorer e americas-recomp. Roda em **Cloudflare Workers +
Durable Objects (SQLite) + KV**. Não hospeda nem distribui nada do jogo.

Estado (2026-11-21): **publicado em https://gta6-coordinator.diogopublio.workers.dev** (smoke 24/24 PASS em produção); MCP ponta a ponta,
exercitado pelo Claude Code real como cliente MCP; 82 testes automatizados. Login Google e repositórios de trabalho
ainda desligados (faltam o cliente OAuth e o GitHub App). Os clones upstream ficam na pasta pai e não são alterados.

## O que faz

- Identidade: login **Google** (OAuth/OIDC com o cliente OAuth do proprietário; cada pessoa usa a própria conta),
  que dá tarefas estratégicas e operacionais; **anônimo** com token persistente, que dá só operacionais.
- Distribui uma tarefa por vez, só desbloqueada e compatível com o perfil (SO, GPU, cópia própria do jogo).
  **Prazo absoluto de 24 h, sem renovação**; resultado tardio é recusado e a tarefa volta para a fila. Modo contínuo.
- Cada reserva ganha um **repositório de trabalho isolado** no GitHub, com `git push` nativo e credencial restrita a
  esse repositório; nenhum token com escrita cobre dois repositórios. O provisionador do GitHub App está implementado e
  liga por configuração depois do portão `tools/github-gate.mjs`.
- Métricas auditáveis: leaderboard por entregas aceitas, tempos, taxa no prazo, uso de modelo auto-relatado
  (real × estimado × desconhecido), agregados e histórico, por pseudônimo.
- Revisão: duas verificações independentes do mesmo commit, mais CI. Reprovação vira tarefa de replanejamento.
- Planejamento por propostas JSON validadas no MCP e numa GitHub Action; o objetivo final é protegido.

## Comandos

```bash
npm test                              # 82 testes + checagem de arquivos gerados
npm run build                         # regenera src/generated/seed.js, schemas/*.json, public/onboarding.html
npx wrangler dev --port 8787          # Worker + Durable Object locais (workerd)
node tools/smoke.mjs http://127.0.0.1:8787   # 24 checagens ponta a ponta contra um servidor rodando
node tools/github-gate.mjs            # portão V-1..V-8 numa org de teste real (precisa do GitHub App)
```

## Documentos

- `docs/SPEC.md`: o que está decidido (D-*) e o que está pendente (P-*).
- `docs/ARCHITECTURE.md`: componentes e fluxos.
- `docs/GITHUB_ISOLATION.md`: repositórios de trabalho, limitações do GitHub verificadas, portão V-1..V-8, riscos.
- `docs/DEPLOY.md`: Cloudflare, Google Cloud Console e GitHub App (passos do proprietário).
- `docs/ONBOARDING.md`: guia do participante (também em `/onboarding.html`).
- `docs/CHALLENGES.md`, `docs/TOOLS.md`: catálogo inicial e ferramentas por projeto.
