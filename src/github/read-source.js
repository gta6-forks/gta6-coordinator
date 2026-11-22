// GitHub READ side: where the task catalog comes from.
// - SeedSource: the checked-in catalog (seed/tasks.json), used until the forks exist.
// - GitHubReadOnlySource: reads issues labelled `gta6-task` from the configured repos and parses the
//   fenced ```gta6-task``` JSON block in the issue body. Read-only; an optional read token raises rate limits.
//   The sub-issue and dependency endpoints are used when available; their exact shape must be confirmed
//   against the live API before production use (docs/SPEC.md §P6).
import { AppError } from '../util.js';

export class SeedSource {
  constructor(seed) {
    this.seed = seed;
  }
  async listTasks() {
    return structuredClone(this.seed.tasks);
  }
  async getRoadmap() {
    return structuredClone(this.seed.roadmap);
  }
}

const BLOCK = /```gta6-task\s*\n([\s\S]*?)\n```/;

export function parseTaskBlock(body) {
  const m = BLOCK.exec(body ?? '');
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    throw new AppError('task_block_invalid', 'gta6-task block is not valid JSON', 422);
  }
}

/** Maps one GitHub issue (REST shape) + its parsed block to a catalog task. GitHub fields win for identity/state. */
export function issueToTask(repo, issue, extra = {}) {
  const block = parseTaskBlock(issue.body);
  if (!block) return null;
  const id = `${repo}#${issue.number}`;
  const depends = new Set([...(block.depends_on ?? []), ...(extra.blockedBy ?? [])]);
  return {
    ...block,
    id,
    repo,
    title: issue.title,
    url: issue.html_url,
    github_kind: issue.pull_request ? 'pull_request' : 'issue',
    state: issue.state === 'closed' ? 'closed' : 'open',
    parent: extra.parent ?? block.parent ?? null,
    kind: extra.hasSubIssues ? 'group' : block.kind ?? (extra.parent ? 'subissue' : 'issue'),
    depends_on: [...depends].filter((d) => d !== id),
  };
}

export class GitHubReadOnlySource {
  constructor({ repos, readToken = null, fetchImpl = fetch, label = 'gta6-task', roadmap }) {
    this.repos = repos;
    this.readToken = readToken;
    this.fetchImpl = fetchImpl;
    this.label = label;
    this.roadmap = roadmap;
  }

  async #get(path) {
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'gta6-coordinator', 'x-github-api-version': '2022-11-28' };
    if (this.readToken) headers.authorization = `Bearer ${this.readToken}`;
    const res = await this.fetchImpl(`https://api.github.com${path}`, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new AppError('github_read_failed', `GET ${path} -> ${res.status}`, 502);
    return res.json();
  }

  async listTasks() {
    const tasks = [];
    for (const repo of this.repos) {
      const issues = (await this.#get(`/repos/${repo}/issues?state=all&labels=${encodeURIComponent(this.label)}&per_page=100`)) ?? [];
      for (const issue of issues) {
        const subs = (await this.#get(`/repos/${repo}/issues/${issue.number}/sub_issues`)) ?? [];
        const blocked = (await this.#get(`/repos/${repo}/issues/${issue.number}/dependencies/blocked_by`)) ?? [];
        const blockedBy = blocked.map((b) => {
          const r = b.repository_url ? b.repository_url.split('/repos/')[1] : repo;
          return `${r}#${b.number}`;
        });
        const parentUrl = issue.parent_issue_url ?? null;
        const parent = parentUrl ? parentUrl.replace(/^.*\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/, '$1#$2') : null;
        const task = issueToTask(repo, issue, { hasSubIssues: subs.length > 0, blockedBy, parent });
        if (task) tasks.push(task);
      }
    }
    return tasks;
  }

  async getRoadmap() {
    return structuredClone(this.roadmap);
  }
}
