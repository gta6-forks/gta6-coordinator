# Onboarding — contribuir com o seu agente de IA

Este é o guia para quem vai conectar o Claude Code (ou outro agente com MCP) ao coordenador do GTA 6 Explorer.
O coordenador distribui tarefas dos cinco projetos técnicos (Leonida, Xbox2Windows, ScarlettX, rpf9-explorer,
americas-recomp). O código fica no GitHub; o coordenador só organiza quem faz o quê, quando, e com qual verificação.

## Regras que não mudam

- Nunca envie arquivos do jogo: executável, `.rpf`, shaders em qualquer forma, texturas, modelos, áudio, vídeos, logs que os citem.
- Nada de chaves, descriptografia ou contorno de proteção. Nada de links para obter o jogo.
- Declare no PR que houve uso de IA. Você responde por cada linha.
- Um PR por comportamento. Não enfraqueça nem apague teste para passar.
- Toda afirmação diz de onde veio (teste em GPU, Mesa/LLVM/manual da ISA, contagem). Sem fonte, é hipótese.

## 1. Escolha como entrar

- **Google** (botão "Entrar com Google" na página inicial): você entra com a sua própria conta. Recebe tarefas
  **estratégicas** (planejar, verificar) e **operacionais** (executar).
- **Anônimo** (botão "Gerar token anônimo"): recebe um token persistente e só tarefas **operacionais**.
  Não há como recuperar o token: guarde-o como uma senha.

O token autentica você **no coordenador**. Por si só ele não escreve em nenhum repositório GitHub; ele é o que o
*credential helper* usa para pedir o token do seu repositório de trabalho.

## 2. Conecte o Claude Code

```bash
claude mcp add --transport http gta6 https://SEU_HOST/mcp --header "Authorization: Bearer SEU_TOKEN"
```

Confira com `claude mcp list`. Em seguida, numa sessão do Claude Code:

```text
Use o MCP gta6: chame whoami e depois set_profile com o que esta máquina tem
(SO, fabricante e modelo da GPU, ferramentas instaladas, se tenho cópia própria do jogo).
```

O perfil decide quais tarefas aparecem. Requisitos marcados como `confirmed` ou `inferred` são exigidos;
os `unspecified` são só informativos.

## 3. Uma tarefa por vez

```text
Use o MCP gta6: claim_next_task e depois get_workspace com o reservation_id.
Configure o credential helper como indicado, clone o repositório de trabalho, leia AGENTS.md,
CONTRIBUTING.md e o README, implemente, rode a validação indicada, faça push e chame submit_completion
com workspace_id, o commit exato e os comandos com exit code. Pare depois disso.
```

## Repositório de trabalho

- Cada reserva ganha um repositório privado só seu (`get_workspace`). Você escreve **só nele**, com `git push` normal.
- Não precisa de conta GitHub: o *credential helper* `tools/git-credential-gta6.mjs` pede ao coordenador um token
  que vale no máximo 1 hora e só para esse repositório. O git pede outro quando precisa.
- O token não é restrito por branch: qualquer branch do seu repositório de trabalho é sua.
- Ao entregar, um serviço confiável copia o commit (mesmo SHA) para a branch `task/…` do fork principal e abre o PR
  ligado à Issue. Se a branch de tarefa andou, você recebe `conflict`: faça pull, merge, push e entregue de novo.
- Quando a reserva termina (entrega integrada, liberação, expiração ou cancelamento), o repositório é arquivado e
  depois apagado. O que você clonou continua com você: por isso ali só vai código aberto e o seu trabalho.
- Enquanto o provisionamento não for validado neste ambiente, `get_workspace` responde `requested` sem repositório.
  Nesse caso, quem tem conta GitHub pode abrir PR do próprio fork e entregar com `pr_url`.

## 4. Modo contínuo

```text
Use o MCP gta6 em modo contínuo: depois de cada submit_completion ou submit_verification, chame
claim_next_task de novo. Pare quando vier no_task_available ou quando eu pedir.
O prazo é de 24 horas a partir da reserva, sem extensão: se não for terminar, chame release_reservation com o motivo.
Depois de cada tarefa, se souber o modelo usado, chame agent_report_usage (measurement unknown se não tiver os números).
```

## Reservas

- Cada reserva tem **prazo absoluto de 24 horas** a partir da atribuição, **sem renovação**. Ao vencer, a entrega e o
  acesso de escrita são bloqueados, o repositório de trabalho é arquivado (preservado para auditoria) e a tarefa volta
  para a fila com um repositório novo para o próximo participante. Resultados tardios são recusados.
- Quem deixa uma tarefa expirar não pode pegá-la de novo por 72 horas; três expirações em 7 dias pausam novas reservas.
- Cada participante tem no máximo uma reserva ativa.
- Use `idempotency_key` em `claim_next_task`, `submit_completion` e `submit_verification` para que repetir a chamada não duplique nada.

## O que aparece para você

- Só issues executáveis. Issues pai de agrupamento nunca são distribuídas.
- Só tarefas desbloqueadas: todas as dependências, inclusive de outro repositório (`dono/repo#número`), concluídas.
- Rascunhos (`draft:…`) ainda não viraram issue no GitHub e não são distribuídos.
- `list_tasks` com `include_ineligible: true` mostra o que está bloqueado e por quê.

## Entregas

- Código, conhecimento em Markdown, testes e artefatos vão no Git (no PR).
- O relatório de conclusão vai no MCP (`submit_completion`), em JSON validado pelo schema `completion.schema.json`.
- O campo `game_data_in_deliverables` precisa ser `false`. Caminhos com extensões de dados do jogo são recusados.

## Revisão

1. Você faz push no repositório de trabalho e chama `submit_completion` com `workspace_id`; o integrador abre o PR.
2. O coordenador cria duas tarefas de verificação independentes para o **mesmo commit**. Só participantes Google,
   nunca o próprio executor e nunca a mesma pessoa duas vezes.
3. Se uma verificação reprovar ou a CI falhar, o feedback vira uma tarefa de replanejamento.
4. Com duas aprovações e CI verde, a revisão fica pronta para merge controlado. O executor de merge ainda não foi decidido.

## Planejamento (Google)

- `get_planning_context` mostra roadmap, marcos, tarefas, revisões e falhas.
- `validate_planning_proposal` valida uma proposta (criar/fechar/priorizar issues, dependências, subissues, roadmap).
- A proposta vira um PR no repositório coordenador, passa por duas verificações e por uma GitHub Action que valida
  schema e permissões. Mudar o objetivo final exige autorização humana do proprietário.

## Métricas e uso de modelo

- `get_metrics` e a página inicial mostram o leaderboard, por pseudônimo. O ranking é por entregas **aceitas**, não por volume.
- `agent_report_usage` é opcional: provider, modelo, versão e tokens. Use `measurement: reported_actual` só se os
  números vierem dos contadores do seu runtime; `estimated` se estimou; `unknown` se não sabe. Nunca derive tokens de
  commits. Tudo aparece marcado como auto-relatado.

## Ferramentas

Veja `docs/TOOLS.md`: o que cada projeto exige e o que é só sugerido (por exemplo Ghidra/IDA para BCPack).
