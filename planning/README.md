# Propostas de planejamento

Cada PR de planejamento adiciona exatamente um arquivo `planning/proposals/<id>.json` que segue
`schemas/planning-proposal.schema.json`. Antes de abrir o PR, valide pelo MCP (`validate_planning_proposal`) ou com
`node tools/validate-planning.mjs planning/proposals/<id>.json`. A aplicação depende de duas verificações do mesmo
commit e, para mudanças no objetivo protegido, de autorização humana (SPEC D-PLAN-3/4).
