#!/usr/bin/env node
// Validation gate V-1..V-8 (docs/GITHUB_ISOLATION.md §6) against a REAL test organization.
// Creates temporary repositories named gate-<random> in WORKSPACE_ORG and deletes them at the end.
//
// Env (same names as the Worker secrets): GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY (PKCS#8 PEM),
//   GITHUB_APP_WORK_INSTALLATION_ID, WORKSPACE_ORG, WORKSPACE_ANCHOR_REPO,
//   GATE_OTHER_REPO (a second repo in the org the participant token must NOT reach).
// Usage: node tools/github-gate.mjs   -> prints PASS/FAIL per gate, exit 1 on any failure.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubAppClient } from '../src/github/app-client.js';

const env = process.env;
for (const k of ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_WORK_INSTALLATION_ID', 'WORKSPACE_ORG', 'WORKSPACE_ANCHOR_REPO', 'GATE_OTHER_REPO']) {
  if (!env[k]) {
    console.error(`missing ${k}`);
    process.exit(2);
  }
}
const gh = new GitHubAppClient({ appId: env.GITHUB_APP_ID, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY });
const org = env.WORKSPACE_ORG;
const inst = env.GITHUB_APP_WORK_INSTALLATION_ID;
let failed = 0;
const result = (gate, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${gate}  ${detail}`);
};
const adminTok = async (name) => (await gh.installationToken(inst, { repositories: [name], permissions: { administration: 'write' } })).token;
const pushWith = (token, repo, files, branch = 'main') => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q', '-b', branch);
  g('config', 'user.email', 'gate@invalid');
  g('config', 'user.name', 'gate');
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  g('add', '-A');
  g('commit', '-q', '-m', 'gate');
  try {
    g('push', '-q', `https://x-access-token:${token}@github.com/${repo}.git`, `HEAD:refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
};

const created = [];
const createRepo = async (name) => {
  const creator = await gh.installationToken(inst, { repositories: [env.WORKSPACE_ANCHOR_REPO] });
  await gh.request('POST', `/orgs/${org}/repos`, { token: creator.token, body: { name, private: true, auto_init: false }, ok: [201] });
  created.push(name);
};

try {
  const name = `gate-${Math.random().toString(16).slice(2, 10)}`;
  const full = `${org}/${name}`;
  try {
    await createRepo(name);
    const repos = await gh.request('GET', `/installation/repositories?per_page=100`, {
      token: (await gh.installationToken(inst, { repositories: [name], permissions: { metadata: 'read' } })).token,
    });
    result('V-1', repos.data.repositories.some((r) => r.name === name), 'private repo created with an installation token and included in the installation');
  } catch (err) {
    result('V-1', false, err.message);
    throw err;
  }

  const part = (await gh.installationToken(inst, { repositories: [name], permissions: { contents: 'write' } })).token;
  const okOwn = pushWith(part, full, { 'README.md': 'gate\n' });
  const okOther = pushWith(part, `${org}/${env.GATE_OTHER_REPO}`, { 'x.txt': 'must fail\n' }, `gate-${Date.now()}`);
  result('V-2', okOwn && !okOther, `push own=${okOwn} other=${okOther} (expected true/false)`);

  const okWf = pushWith(part, full, { '.github/workflows/x.yml': 'on: push\njobs: {}\n' }, 'wf');
  result('V-3', !okWf, `push touching .github/workflows with contents-only token: ${okWf} (expected false)`);

  const admin = await adminTok(name);
  await gh.request('PUT', `/repos/${full}/actions/permissions`, { token: admin, body: { enabled: false }, ok: [204] });
  const perm = await gh.request('GET', `/repos/${full}/actions/permissions`, { token: admin });
  result('V-5', perm.data.enabled === false, 'Actions disabled on the work repository');

  const live = (await gh.installationToken(inst, { repositories: [name], permissions: { contents: 'write' } })).token;
  await gh.request('PATCH', `/repos/${full}`, { token: admin, body: { archived: true } });
  const okArchived = pushWith(live, full, { 'late.txt': 'x\n' }, 'late');
  result('V-4', !okArchived, `push to archived repo with a still-valid token: ${okArchived} (expected false)`);

  const rev = (await gh.installationToken(inst, { repositories: [name], permissions: { contents: 'read' } })).token;
  await gh.request('DELETE', '/installation/token', { token: rev, ok: [204] });
  let after = 0;
  try {
    await gh.request('GET', `/repos/${full}`, { token: rev });
    after = 200;
  } catch (err) {
    after = err.githubStatus;
  }
  result('V-6', after === 401, `token used after DELETE /installation/token -> ${after} (expected 401)`);

  result('V-7', true, 'SKIPPED here: run the workspace-integrate workflow once with a real dispatch (needs the coordinator repo)');

  const t0 = Date.now();
  let made = 0;
  try {
    for (let i = 0; i < 5; i++) {
      await createRepo(`gate-burst-${Date.now()}-${i}`);
      made++;
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (err) {
    console.log(`  burst stopped: ${err.message}`);
  }
  result('V-8', made === 5, `${made}/5 repositories in ${Date.now() - t0} ms with 1 s spacing`);
} catch (err) {
  console.error(`gate aborted: ${err.message}`);
  failed++;
} finally {
  for (const n of created) {
    try {
      await gh.request('DELETE', `/repos/${org}/${n}`, { token: await adminTok(n), ok: [204] });
    } catch (err) {
      console.error(`cleanup ${n}: ${err.message}`);
    }
  }
}
process.exit(failed ? 1 : 0);
