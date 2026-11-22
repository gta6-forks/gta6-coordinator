# Os 10 desafios do catálogo inicial

Investigados em 2026-11-21 nos clones locais dos cinco projetos e nas issues/PRs do
GitHub. A fonte de verdade é `seed/tasks.json`, que tem para cada um a origem exata, os requisitos por fase
(implementação × validação; obrigatórios/opcionais/sugeridos) com confiança, e os critérios de aceitação.

| # | ID | Projeto | Prontidão | Dificuldade (estimada) | Jogo na implementação / validação |
|---|---|---|---|---|---|
| D1 | `R0Y00/Xbox2Windows#77` | Xbox2Windows | ready | baixa | não / não |
| D2 | `R0Y00/Xbox2Windows#126` | Xbox2Windows | needs_info (critério de aceitação não definido) | média | não / indeterminado |
| D3 | `draft:ItsNotRexed/Leonida/system-values` | Leonida | draft (sem issue) | alta | não (inferido) / opcional |
| D4 | `ItsNotRexed/Leonida#29` | Leonida | ready, **bloqueada** por `breadbbbb/rpf9-explorer#1` | baixa | não / sim |
| D5 | `draft:Freminet/ScarlettX/guest-texture-upload` | ScarlettX | draft, subissue de `draft:Freminet/ScarlettX/failing-tests` (grupo) | média | não / não |
| D6 | `draft:Freminet/ScarlettX/child-process-boot` | ScarlettX | draft, subissue do mesmo grupo | baixa | não / não |
| D7 | `breadbbbb/rpf9-explorer#1` (PR) | rpf9-explorer | ready | média | não (smoke) / opcional (contagem completa) |
| D8 | `draft:breadbbbb/rpf9-explorer/bcpack-decoder` | rpf9-explorer | draft | alta | — / indeterminado |
| D9 | `draft:realdody/americas-recomp/f16-interpolation` | americas-recomp | draft | alta | não (inferido) / opcional |
| D10 | `draft:realdody/americas-recomp/xgameruntime-standin` | americas-recomp | draft | alta | não (inferido) / opcional |

Mais uma tarefa estratégica: `local:plan/bootstrap-issues` (p0), que converte os rascunhos em issues, define o
critério do D2 e divide o D10 em subissues.

Excluído de propósito: decodificar o diretório original do RPF9. O README do Leonida liga o `shaders.rpf` a uma
tabela de conteúdo cifrada, e descriptografia está fora das regras (SPEC D-RULE-2).

Hoje um participante anônimo com Windows recebe o D1; com o D7 concluído, o D4 desbloqueia. Os rascunhos só entram
na fila depois de virarem issues pelo fluxo de planejamento.
