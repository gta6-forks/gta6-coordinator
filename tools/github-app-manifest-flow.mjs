#!/usr/bin/env node
// Local helper for GitHub's official "create a GitHub App from a manifest" flow.
//   node tools/github-app-manifest-flow.mjs        -> open http://127.0.0.1:8799/ in the browser
// The page posts docs/github-app-manifest.json to github.com (personal account or an org you type).
// GitHub redirects back here with a one-time code; this script exchanges it
// (POST /app-manifests/{code}/conversions) and saves the App credentials to
// ~/.config/gta6-coordinator/github-app.json (chmod 600). Nothing secret is printed or sent elsewhere.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.PORT ?? 8799);
const OUT_DIR = join(homedir(), '.config', 'gta6-coordinator');
const OUT = join(OUT_DIR, 'github-app.json');
const manifest = JSON.parse(readFileSync(new URL('../docs/github-app-manifest.json', import.meta.url), 'utf8'));
manifest.redirect_url = `http://127.0.0.1:${PORT}/callback`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const ORG_RE = /^[A-Za-z0-9-]{1,39}$/;

const page = (body) => `<!doctype html><meta charset="utf-8"><title>GitHub App</title>
<body style="font:16px system-ui;max-width:640px;margin:40px auto;padding:0 16px">${body}</body>`;

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/') {
    const org = url.searchParams.get('org') ?? '';
    const action = org && ORG_RE.test(org)
      ? `https://github.com/organizations/${org}/settings/apps/new`
      : 'https://github.com/settings/apps/new';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page(`<h1>Create the coordinator GitHub App</h1>
<p>Owner: <b>${org ? esc(org) : 'your personal account'}</b>. To create it in an org, open
<code>http://127.0.0.1:${PORT}/?org=NAME</code> (the org must exist and you must be an owner).</p>
<pre style="background:#f4f4f4;padding:12px;overflow:auto">${esc(JSON.stringify(manifest, null, 2))}</pre>
<form method="post" action="${esc(action)}">
<input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}">
<button style="font-size:18px;padding:8px 16px">Continue on GitHub</button></form>`));
    return;
  }
  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code') ?? '';
    if (!/^[A-Za-z0-9_-]{8,}$/.test(code)) {
      res.writeHead(400).end('missing code');
      return;
    }
    try {
      const r = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
        method: 'POST',
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'gta6-coordinator-setup' },
      });
      const app = await r.json();
      if (!r.ok) throw new Error(`GitHub ${r.status}: ${app.message ?? ''}`);
      const pkcs8 = createPrivateKey(app.pem).export({ type: 'pkcs8', format: 'pem' });
      mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(OUT, JSON.stringify({
        GITHUB_APP_ID: String(app.id),
        GITHUB_APP_SLUG: app.slug,
        GITHUB_APP_OWNER: app.owner?.login,
        GITHUB_APP_CLIENT_ID: app.client_id,
        GITHUB_APP_CLIENT_SECRET: app.client_secret,
        GITHUB_WEBHOOK_SECRET: app.webhook_secret,
        GITHUB_APP_PRIVATE_KEY: pkcs8,
      }, null, 2), { mode: 0o600 });
      chmodSync(OUT, 0o600);
      console.log(`saved App id=${app.id} slug=${app.slug} owner=${app.owner?.login} -> ${OUT}`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page(`<h1>App created: ${esc(app.slug)}</h1><p>Credentials saved locally (mode 600). Next step:
<a href="https://github.com/apps/${esc(app.slug)}/installations/new">install the App</a> on the work org,
with "All repositories" (dedicated org). You can close this tab.</p>`));
      setTimeout(() => process.exit(0), 500);
    } catch (err) {
      console.error(`conversion failed: ${err.message}`);
      res.writeHead(500, { 'content-type': 'text/plain' }).end('conversion failed; see terminal');
    }
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, '127.0.0.1', () => console.log(`open http://127.0.0.1:${PORT}/`));
