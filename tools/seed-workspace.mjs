#!/usr/bin/env node
// Trusted seeding step, run ONLY inside .github/workflows/workspace-integrate.yml (job "seed").
// Copies the task branch of the main fork (public, read without credentials) into the new, empty work repository,
// so the participant only ever pushes their own commits. The fork history may contain .github/workflows/, which a
// participant token (contents:write only) is not allowed to push; this job's token adds workflows:write, still for
// ONE repository (the work repository).
// Env: GTA6_APP_ID, GTA6_APP_PRIVATE_KEY, GTA6_WORK_INSTALLATION_ID, P (JSON client_payload),
//      GTA6_COORDINATOR_URL, GTA6_INTEGRATION_CALLBACK_SECRET.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callback, git, redact, repoToken } from './integrate-workspace.mjs';

async function main() {
  const p = JSON.parse(process.env.P);
  if (!/^[0-9a-f]{40}$/.test(p.base_sha ?? '')) throw new Error('base_sha missing');
  const workName = p.workspace_repo.split('/')[1];
  const dir = mkdtempSync(join(tmpdir(), 'seed-'));
  git(dir, ['init', '-q', '--bare']);
  git(dir, ['fetch', '-q', `https://github.com/${p.integration_repo}.git`, `+refs/heads/${p.task_branch}:refs/gta6/fork`]);
  git(dir, ['cat-file', '-e', `${p.base_sha}^{commit}`]);
  const token = await repoToken(process.env.GTA6_WORK_INSTALLATION_ID, workName, { contents: 'write', workflows: 'write' });
  git(dir, ['push', '-q', `https://github.com/${p.workspace_repo}.git`, `${p.base_sha}:refs/heads/${p.task_branch}`], { [p.workspace_repo]: token });
  await callback({ workspace_id: p.workspace_id, outcome: 'seeded', commit_sha: p.base_sha });
}

main().catch(async (err) => {
  console.error(redact(err.message));
  try {
    const p = JSON.parse(process.env.P ?? '{}');
    if (p.workspace_id) await callback({ workspace_id: p.workspace_id, outcome: 'seed_failed', detail: redact(err.message).slice(0, 500) });
  } catch {}
  process.exit(1);
});
