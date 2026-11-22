#!/usr/bin/env node
// Trusted integration step, run ONLY inside .github/workflows/workspace-integrate.yml (GitHub Actions runner,
// native git).
//
// Env: GTA6_APP_ID, GTA6_APP_PRIVATE_KEY, GTA6_WORK_INSTALLATION_ID, GTA6_FORKS_INSTALLATION_ID,
//      P (JSON client_payload), GTA6_COORDINATOR_URL, GTA6_INTEGRATION_CALLBACK_SECRET.
// Tokens: contents:read on the work repo; contents+pull_requests write on the main fork only (never one token for both).
// Guarantees: never rewrites the submitted commit (fast-forward only), never pushes outside task_branch,
// refuses forbidden content before anything reaches the integration repository.
import { execFileSync } from 'node:child_process';
import { createSign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FORBIDDEN_EXT = /\.(rpf|ysc|ytd|ydr|yft|ydd|ybn|ymap|ytyp|awc|ttpf|xvd|xvc|msixvc|exe|dll|pdb|dxbc|fssm|spv|dds|bk2|r9texdata|r9modeldata|zip|7z|rar)$/i;
const FORBIDDEN_PATH = /(^|\/)(\.github\/workflows\/|game-files\/|MicrosoftGame\.Config$|appxmanifest\.xml$)/i;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** changes: [{ path, size }] for every added/modified blob between base and head. */
export function scanChanges(changes) {
  const violations = [];
  for (const c of changes) {
    if (FORBIDDEN_EXT.test(c.path)) violations.push(`${c.path}: forbidden file type`);
    if (FORBIDDEN_PATH.test(c.path)) violations.push(`${c.path}: forbidden path`);
    if (c.size > MAX_FILE_BYTES) violations.push(`${c.path}: ${c.size} bytes > ${MAX_FILE_BYTES}`);
  }
  return violations;
}

// One header per remote URL, so each token is only ever sent to its own repository.
function git(cwd, args, auth = {}) {
  const cfg = [];
  for (const [repo, token] of Object.entries(auth)) {
    const b = Buffer.from(`x-access-token:${token}`).toString('base64');
    cfg.push('-c', `http.https://github.com/${repo}.git.extraheader=AUTHORIZATION: basic ${b}`);
  }
  return execFileSync('git', [...cfg, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function appJwt() {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: now - 60, exp: now + 540, iss: String(process.env.GTA6_APP_ID) })}`;
  return `${data}.${createSign('RSA-SHA256').update(data).sign(process.env.GTA6_APP_PRIVATE_KEY, 'base64url')}`;
}

/** Installation token; a token with write permission always covers exactly one repository. */
export async function repoToken(installationId, repoName, permissions) {
  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${appJwt()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    body: JSON.stringify({ repositories: [repoName], permissions }),
  });
  if (res.status !== 201) throw new Error(`token for ${repoName}: ${res.status}`);
  return (await res.json()).token;
}

async function callback(body) {
  const res = await fetch(`${process.env.GTA6_COORDINATOR_URL.replace(/\/$/, '')}/api/integration`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-coordinator-secret': process.env.GTA6_INTEGRATION_CALLBACK_SECRET },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`callback failed: ${res.status}`);
}

async function main() {
  const p = JSON.parse(process.env.P);
  const workName = p.workspace_repo.split('/')[1];
  const forkName = p.integration_repo.split('/')[1];
  const readWork = await repoToken(process.env.GTA6_WORK_INSTALLATION_ID, workName, { contents: 'read' });
  const writeFork = await repoToken(process.env.GTA6_FORKS_INSTALLATION_ID, forkName, { contents: 'write', pull_requests: 'write' });
  const auth = { [p.workspace_repo]: readWork, [p.integration_repo]: writeFork };
  const dir = mkdtempSync(join(tmpdir(), 'integrate-'));
  git(dir, ['init', '-q']);
  git(dir, ['remote', 'add', 'integration', `https://github.com/${p.integration_repo}.git`]);
  git(dir, ['remote', 'add', 'work', `https://github.com/${p.workspace_repo}.git`]);
  git(dir, ['fetch', '-q', 'integration', `+refs/heads/${p.task_branch}:refs/remotes/integration/task`], auth);
  git(dir, ['fetch', '-q', 'work', p.head_sha], auth);

  const base = git(dir, ['rev-parse', 'refs/remotes/integration/task']);
  try {
    git(dir, ['merge-base', '--is-ancestor', base, p.head_sha]);
  } catch {
    await callback({ workspace_id: p.workspace_id, outcome: 'conflict', detail: `task branch ${p.task_branch} is at ${base}; pull it, merge, push and resubmit` });
    return;
  }
  const changed = git(dir, ['diff', '--name-only', '--diff-filter=AM', base, p.head_sha]).split('\n').filter(Boolean);
  const changes = changed.map((path) => ({ path, size: Number(git(dir, ['cat-file', '-s', `${p.head_sha}:${path}`])) }));
  const violations = scanChanges(changes);
  if (violations.length) {
    await callback({ workspace_id: p.workspace_id, outcome: 'forbidden_content', detail: violations.slice(0, 20).join('; ') });
    return;
  }
  git(dir, ['push', '-q', 'integration', `${p.head_sha}:refs/heads/${p.task_branch}`], auth);

  const api = (path, init = {}) =>
    fetch(`https://api.github.com${path}`, {
      ...init,
      headers: { authorization: `Bearer ${writeFork}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(init.headers ?? {}) },
    });
  const [owner] = p.integration_repo.split('/');
  const existing = await (await api(`/repos/${p.integration_repo}/pulls?head=${owner}:${encodeURIComponent(p.task_branch)}&state=open`)).json();
  let pr = existing[0];
  if (!pr) {
    const res = await api(`/repos/${p.integration_repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ title: `${p.issue}: integração do coordenador`, head: p.task_branch, base: p.base_branch ?? 'main', body: `Refs ${p.issue}\n\nIntegrado do repositório de trabalho do coordenador (commit ${p.head_sha}).` }),
    });
    if (!res.ok) throw new Error(`create PR failed: ${res.status}`);
    pr = await res.json();
  }
  await callback({ workspace_id: p.workspace_id, outcome: 'integrated', commit_sha: p.head_sha, pr_url: pr.html_url });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (err) => {
    console.error(err.message);
    try {
      const p = JSON.parse(process.env.P ?? '{}');
      if (p.workspace_id) await callback({ workspace_id: p.workspace_id, outcome: 'error', detail: err.message.slice(0, 500) });
    } catch {}
    process.exit(1);
  });
}
