// GitHub side of applying an approved planning proposal (docs/SPEC.md, D-PLAN).
// Runs in the Worker with the GitHub App; every WRITE token names exactly one repository (GitHubAppClient enforces it).
//   - reads the proposal file(s) of a merged planning PR in the coordinator repository
//   - creates/edits the `gta6-task` issues in the main forks
import { AppError, b64urlDecode } from '../util.js';
import { GitHubAppClient } from './app-client.js';

export const TASK_LABEL = 'gta6-task';
const PROPOSAL_PATH = /^planning\/proposals\/[a-z0-9][a-z0-9-]{2,79}\.json$/;
const BLOCK = /```gta6-task\s*\n[\s\S]*?\n```/;

const split = (full) => {
  const [owner, name] = String(full).split('/');
  return { owner, name };
};

export function renderTaskBlock(block) {
  return '```gta6-task\n' + JSON.stringify(block, null, 2) + '\n```';
}

/** Replaces (or appends) the gta6-task block of an issue body. */
export function withTaskBlock(body, block) {
  const rendered = renderTaskBlock(block);
  return BLOCK.test(body ?? '') ? body.replace(BLOCK, () => rendered) : `${body ?? ''}\n\n${rendered}`;
}

function decodeBase64(b64) {
  return new TextDecoder().decode(b64urlDecode(String(b64).replace(/\n/g, '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')));
}

export class GitHubPlanner {
  constructor(env, { fetchImpl = (...args) => fetch(...args), now = () => Date.now(), sleep } = {}) {
    for (const k of ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_FORKS_INSTALLATION_ID', 'COORDINATOR_REPO']) {
      if (!env[k]) throw new AppError('github_app_not_configured', `${k} missing`, 503);
    }
    this.env = env;
    this.gh = new GitHubAppClient({ appId: env.GITHUB_APP_ID, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY, fetchImpl, now, sleep });
    this.inst = env.GITHUB_APP_FORKS_INSTALLATION_ID;
    this.coord = env.COORDINATOR_REPO;
  }

  async #token(repo, permissions) {
    return (await this.gh.installationToken(this.inst, { repositories: [split(repo).name], permissions })).token;
  }

  /** Read-only token for listing the task issues of several forks (read permissions may span repositories). */
  async readToken(repos) {
    const names = repos.map((r) => split(r).name);
    return (await this.gh.installationToken(this.inst, { repositories: names, permissions: { issues: 'read', metadata: 'read' } })).token;
  }

  /** Proposal files added/changed by a merged PR in the coordinator repository, read at the merge commit. */
  async readProposalFiles(prNumber) {
    const token = await this.#token(this.coord, { contents: 'read', pull_requests: 'read' });
    const pr = (await this.gh.request('GET', `/repos/${this.coord}/pulls/${prNumber}`, { token })).data;
    if (!pr.merged || !pr.merge_commit_sha) throw new AppError('pr_not_merged', `PR #${prNumber} is not merged`, 409);
    const files = (await this.gh.request('GET', `/repos/${this.coord}/pulls/${prNumber}/files?per_page=100`, { token })).data;
    const out = [];
    for (const f of files) {
      if (!PROPOSAL_PATH.test(f.filename) || !['added', 'modified'].includes(f.status)) continue;
      const c = (await this.gh.request('GET', `/repos/${this.coord}/contents/${f.filename}?ref=${pr.merge_commit_sha}`, { token })).data;
      try {
        out.push({ path: f.filename, proposal: JSON.parse(decodeBase64(c.content)) });
      } catch {
        out.push({ path: f.filename, proposal: null, error: 'not valid JSON' });
      }
    }
    return { merge_commit_sha: pr.merge_commit_sha, files: out };
  }

  async findIssueByMarker(repo, marker) {
    const token = await this.#token(repo, { issues: 'read' });
    for (let page = 1; page <= 10; page++) {
      const list = (await this.gh.request('GET', `/repos/${repo}/issues?state=all&labels=${TASK_LABEL}&per_page=100&page=${page}`, { token })).data;
      const hit = list.find((i) => !i.pull_request && String(i.body ?? '').includes(marker));
      if (hit) return hit;
      if (list.length < 100) return null;
    }
    return null;
  }

  async createIssue(repo, { title, body }) {
    const token = await this.#token(repo, { issues: 'write' });
    try {
      await this.gh.request('POST', `/repos/${repo}/labels`, { token, body: { name: TASK_LABEL, color: '0b6e4f', description: 'Task served by the GTA6 Explorer coordinator' }, ok: [201] });
    } catch (err) {
      if (err.githubStatus !== 422) throw err; // 422 = label already exists
    }
    return (await this.gh.request('POST', `/repos/${repo}/issues`, { token, body: { title, body, labels: [TASK_LABEL] }, ok: [201] })).data;
  }

  async getIssue(repo, number) {
    const token = await this.#token(repo, { issues: 'read' });
    return (await this.gh.request('GET', `/repos/${repo}/issues/${number}`, { token })).data;
  }

  async updateIssue(repo, number, patch) {
    const token = await this.#token(repo, { issues: 'write' });
    return (await this.gh.request('PATCH', `/repos/${repo}/issues/${number}`, { token, body: patch })).data;
  }

  async addSubIssue(repo, parentNumber, childIssueId) {
    const token = await this.#token(repo, { issues: 'write' });
    await this.gh.request('POST', `/repos/${repo}/issues/${parentNumber}/sub_issues`, { token, body: { sub_issue_id: childIssueId }, ok: [201] });
  }
}

export function createPlanner(env, opts = {}) {
  try {
    return new GitHubPlanner(env, opts);
  } catch {
    return null;
  }
}

/** Check runs of a commit in a public main fork / coordinator repo (read-only, metadata permission is enough). */
GitHubPlanner.prototype.checkRuns = async function checkRuns(repo, sha) {
  const token = (await this.gh.installationToken(this.inst, { repositories: [String(repo).split('/')[1]], permissions: { metadata: 'read' } })).token;
  return (await this.gh.request('GET', `/repos/${repo}/commits/${sha}/check-runs?per_page=100`, { token })).data.check_runs ?? [];
};
