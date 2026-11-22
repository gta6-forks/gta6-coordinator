# Implantação (Cloudflare) e configuração do Google OAuth

Nada disto foi executado. Os passos marcados **[Di]** dependem da conta do proprietário.

## 1. Pré-requisitos locais

- Node 22.5+ (testado com Node 24).
- `npm install` instala o `wrangler` (devDependency). Ainda não foi instalado neste workspace.

```bash
npm install
npm test                 # testes + checagem de arquivos gerados
npm run build            # regenera seed, schemas e onboarding depois de editar as fontes
```

## 2. Google Cloud Console **[Di]**

O cliente OAuth pertence a um projeto administrado pela conta Google do proprietário. Os participantes entram com as
próprias contas; a conta do proprietário só administra o cliente.

1. Em <https://console.cloud.google.com/>, crie (ou escolha) um projeto, por exemplo `gta6-explorer-coordinator`.
2. **APIs e serviços → Tela de consentimento OAuth** (Google Auth Platform → Branding/Audience):
   - Tipo de usuário **Externo**.
   - Nome do app, e-mail de suporte, domínio autorizado (o hostname de produção, quando existir).
   - Escopos: apenas `openid`, `email`, `profile` (não sensíveis; não exigem verificação do Google).
   - Enquanto estiver em **Testing**, só os usuários de teste cadastrados conseguem entrar. Para abrir ao público,
     publique o app (**In production**).
3. **Credenciais → Criar credenciais → ID do cliente OAuth → Aplicativo da Web**:
   - Origens JavaScript autorizadas: não são necessárias (o fluxo é servidor a servidor).
   - URIs de redirecionamento autorizados:
     - `http://localhost:8787/auth/google/callback` (desenvolvimento com `wrangler dev`)
     - `https://mcp.gtaagents.app/auth/google/callback` (produção; o mesmo `PUBLIC_BASE_URL` do `wrangler.jsonc`)
4. Copie o **Client ID** e o **Client secret**. Não os coloque em nenhum arquivo versionado.

## 3. Cloudflare **[Di]**

```bash
npx wrangler login                                   # conta Cloudflare do proprietário
npx wrangler kv namespace create OAUTH_KV            # dev
npx wrangler kv namespace create OAUTH_KV --env production
```

Cole os IDs em `wrangler.jsonc` (`REPLACE_WITH_OAUTH_KV_NAMESPACE_ID` e
`REPLACE_WITH_PRODUCTION_OAUTH_KV_NAMESPACE_ID`) e o hostname em `PUBLIC_BASE_URL` do ambiente `production`.

Secrets de produção:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID     --env production
npx wrangler secret put GOOGLE_CLIENT_SECRET --env production
npx wrangler secret put TOKEN_PEPPER         --env production   # openssl rand -base64 32
npx wrangler secret put CI_WEBHOOK_SECRET    --env production   # opcional
```

`TOKEN_PEPPER` não pode mudar depois de emitir tokens: mudar invalida todos.

## 4. Desenvolvimento local

```bash
cp .dev.vars.example .dev.vars    # preencher; .dev.vars é ignorado pelo git
npx wrangler dev                  # http://localhost:8787
```

Sem `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, o botão Google aparece desativado e o resto funciona.

## 4b. Teste local ponta a ponta (executado em 2026-11-21)

```bash
npx wrangler dev --port 8787            # workerd local, Durable Object SQLite real
node tools/smoke.mjs http://127.0.0.1:8787
```

## 5. Publicação **[Di]**

```bash
npm test
npx wrangler deploy --dry-run --outdir dist    # confere o bundle sem publicar
npx wrangler deploy --env production
```

A primeira publicação aplica a migration `v1` do Durable Object (`new_sqlite_classes: ["Coordinator"]`) e o
próprio objeto cria as tabelas na primeira requisição.

## 6. Depois de publicar

- Abrir `https://mcp.gtaagents.app/`, gerar um token anônimo e conectar:
  `claude mcp add --transport http gta6 https://mcp.gtaagents.app/mcp --header "Authorization: Bearer …"`.
- Testar o login Google com uma conta de teste cadastrada na tela de consentimento.
- `GET /health` deve mostrar `git_write.writes_enabled: false`.

## 5b. Estado da publicação (2026-11-21)

- Publicado na conta Cloudflare pessoal (alias `wrangler-pessoal`) em <https://mcp.gtaagents.app>, worker `gta6-coordinator`
  (`--env production`), KV `OAUTH_KV` de produção criado, secrets `TOKEN_PEPPER`, `CI_WEBHOOK_SECRET`,
  `INTEGRATION_CALLBACK_SECRET` e `GITHUB_WEBHOOK_SECRET` definidos. Cópia local dos valores:
  `~/.config/gta6-coordinator/production.secrets.json` (600, fora do repositório).
- `node tools/smoke.mjs https://mcp.gtaagents.app`: 24/24 PASS.
- Login Google desligado até `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`; provisionador de repositórios desligado
  (`WORKSPACE_PROVISIONER=disabled`) até o portão V-1..V-8.

## 7. GitHub App e repositórios de trabalho **[Di]** (só depois do portão V-1..V-8)

1. Criar uma org de trabalho (por exemplo `gta6-work`) e, se possível, uma org de teste para o portão.
2. Registrar um GitHub App pertencente à org. Caminho recomendado: `node tools/github-app-manifest-flow.mjs` e abrir
   `http://127.0.0.1:8799/?org=<org>` (fluxo oficial de manifesto; a chave sai já em PKCS#8 em
   `~/.config/gta6-coordinator/github-app.json`, 600). Manualmente (Settings → Developer settings → GitHub Apps):
   - Permissões de repositório: Contents (write), Metadata (read), Pull requests (write), Administration (write),
     e na org **Repository creation** (write). Sem Workflows.
   - Webhook: `https://mcp.gtaagents.app/api/github/webhook`, com secret; eventos `pull_request` e `push`.
3. Instalar o App na org de trabalho e nos forks principais.
4. Gerar a chave privada (PKCS#1) e converter: `openssl pkcs8 -topk8 -nocrypt -in app.pem -out app.pkcs8.pem`.
5. Secrets do Worker (`--env production`): `GITHUB_APP_ID`, `GITHUB_APP_WORK_INSTALLATION_ID`,
   `GITHUB_APP_FORKS_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY` (PKCS#8), `GITHUB_WEBHOOK_SECRET`,
   `INTEGRATION_CALLBACK_SECRET`. Vars: `WORKSPACE_ORG`, `WORKSPACE_ANCHOR_REPO` (criar um repositório vazio com esse
   nome na org de trabalho), `COORDINATOR_REPO`. O manifesto do App está em `docs/github-app-manifest.json`.
6. No repositório coordenador: secrets `GTA6_APP_PRIVATE_KEY` e `GTA6_INTEGRATION_CALLBACK_SECRET`; vars
   `GTA6_APP_ID`, `GTA6_WORK_INSTALLATION_ID`, `GTA6_FORKS_INSTALLATION_ID`, `GTA6_COORDINATOR_URL`.
7. Rodar o portão: `GATE_OTHER_REPO=<outro repo da org> node tools/github-gate.mjs` com as mesmas variáveis. Com tudo
   PASS, ligar `WORKSPACE_PROVISIONER=github-app` e conferir com `node tools/smoke.mjs https://mcp.gtaagents.app`.

## O que continua fora deste guia

O executor de merge na `main` e a aplicação automática do planejamento (SPEC P-3).
