#!/usr/bin/env node
// Git credential helper for GTA 6 Explorer work repositories (participant side, Node 18+).
//
//   git config --global credential.https://github.com/ORG/REPO.git.helper "!node /path/git-credential-gta6.mjs"
//   git config --global credential.https://github.com/ORG/REPO.git.useHttpPath true
//   export GTA6_TOKEN=g6a_…            # your coordinator token (or GTA6_TOKEN_FILE=/path/to/file)
//   export GTA6_URL=https://HOST        # coordinator base URL
//
// On `get`, git sends protocol/host/path; this helper asks the coordinator for a fresh token that can write
// ONLY to that repository while your reservation is active (GitHub caps it at 1 hour; git asks again when needed).
// `store`/`erase` are ignored: nothing is written to disk by this helper.
import { readFileSync } from 'node:fs';

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return Object.fromEntries(
    data.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}

async function main() {
  const op = process.argv[2];
  if (op !== 'get') return;
  const input = await readStdin();
  if (input.protocol !== 'https' || input.host !== 'github.com' || !input.path) return; // not ours: let git try other helpers
  const token = process.env.GTA6_TOKEN || (process.env.GTA6_TOKEN_FILE ? readFileSync(process.env.GTA6_TOKEN_FILE, 'utf8').trim() : '');
  const base = (process.env.GTA6_URL || '').replace(/\/$/, '');
  if (!token || !base) {
    process.stderr.write('gta6 credential helper: set GTA6_TOKEN (or GTA6_TOKEN_FILE) and GTA6_URL\n');
    return;
  }
  const res = await fetch(`${base}/api/git/credential`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: 'https', host: 'github.com', path: input.path }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    process.stderr.write(`gta6 credential helper: ${body.error?.code ?? res.status} ${body.error?.message ?? ''}\n`);
    return;
  }
  process.stdout.write(`username=${body.username}\npassword=${body.password}\n`);
}

main().catch((err) => {
  process.stderr.write(`gta6 credential helper: ${err.message}\n`);
});
