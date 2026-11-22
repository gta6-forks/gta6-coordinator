#!/usr/bin/env node
// Used by .github/workflows/planning.yml.
//   node tools/validate-planning.mjs <proposal.json>...           validate against schema + catalog
//   node tools/validate-planning.mjs --apply <proposal.json>...   validate, check gates, call the write adapter
//
// Gates for --apply (all required):
//   PLANNING_VERIFICATIONS >= 2           (approvals recorded for the same commit; set by the workflow)
//   PLANNING_HUMAN_APPROVED=true          only when the proposal touches the protected objective/milestones
// The write adapter is still the pending stub, so --apply never changes GitHub today: it reports
// "pending_decision" and exits 0. It never pushes and never bypasses branch protection.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProposal } from '../src/services/planning.js';
import { normalizeTask } from '../src/domain/task.js';
import { PendingGitWriteAdapter } from '../src/github/write-adapter.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadCatalog() {
  const tasks = JSON.parse(readFileSync(join(root, 'seed/tasks.json'), 'utf8'))
    .map((raw) => normalizeTask(raw).task)
    .filter(Boolean)
    .map((t) => ({ id: t.id, depends_on: t.depends_on, kind: t.kind, executable: t.executable, readiness: t.readiness }));
  const roadmap = JSON.parse(readFileSync(join(root, 'seed/roadmap.json'), 'utf8'));
  return { tasks, roadmap };
}

export async function run(argv, env = process.env, log = console.log) {
  const apply = argv.includes('--apply');
  const files = argv.filter((a) => !a.startsWith('--'));
  if (!files.length) {
    log('usage: validate-planning.mjs [--apply] <proposal.json>...');
    return 2;
  }
  const catalog = loadCatalog();
  let exit = 0;
  for (const file of files) {
    let proposal;
    try {
      proposal = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      log(`::error file=${file}::not valid JSON: ${err.message}`);
      exit = 1;
      continue;
    }
    const result = validateProposal(proposal, catalog);
    for (const e of result.errors) log(`::error file=${file}::${e}`);
    for (const w of result.warnings) log(`::warning file=${file}::${w}`);
    if (!result.valid) {
      exit = 1;
      continue;
    }
    log(`${file}: valid (${JSON.stringify(result.summary)}), requires_human_authorization=${result.requires_human_authorization}`);
    if (!apply) continue;

    const verifications = Number(env.PLANNING_VERIFICATIONS ?? 0);
    if (verifications < 2) {
      log(`::error file=${file}::needs 2 independent verifications of the same commit (got ${verifications})`);
      exit = 1;
      continue;
    }
    if (result.requires_human_authorization && env.PLANNING_HUMAN_APPROVED !== 'true') {
      log(`::error file=${file}::touches the protected objective; needs explicit human authorization`);
      exit = 1;
      continue;
    }
    const outcome = await new PendingGitWriteAdapter().applyPlanning({ proposal });
    log(`${file}: apply -> ${outcome.status} (${outcome.next_step ?? ''})`);
  }
  return exit;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
