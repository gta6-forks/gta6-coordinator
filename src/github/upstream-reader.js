// READ-ONLY access to the ORIGINAL (upstream) repositories, used by the upstream reconciler
// (src/services/upstream.js). Never writes to GitHub.
//   - conditional requests (ETag / If-None-Match): a 304 reuses the cached body and, when authenticated,
//     does not count against the primary rate limit
//   - rate limit aware: stops before x-ratelimit-remaining drops under a floor, honours retry-after
//   - a per-run request budget, so one run can never burn the hourly quota
//   - errors are returned as values ({ ok:false, ... }); the reconciler decides what they mean
const API = 'https://api.github.com';

export class UpstreamBudgetExhausted extends Error {
  constructor(reason, resumeAt = null) {
    super(`upstream read budget exhausted: ${reason}`);
    this.reason = reason;
    this.resumeAt = resumeAt;
  }
}

/** Markdown headings of a contents-API file (to tell "the cited section is gone" from "the file changed"). */
export function markdownHeadings(f) {
  if (!f?.content || f.encoding !== 'base64' || !/\.(md|markdown)$/i.test(f.path ?? '')) return null;
  try {
    const bin = atob(String(f.content).replace(/\n/g, ''));
    const text = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    return text.split('\n').filter((l) => /^#{1,6}\s/.test(l)).map((l) => l.replace(/^#+\s*/, '').trim()).slice(0, 300);
  } catch {
    return null;
  }
}

export class UpstreamReader {
  /**
   * @param store        coordinator store (HTTP cache table upstream_http_cache)
   * @param token        optional read token (raises the limit from 60/h to 5000/h)
   * @param maxRequests  hard cap of network requests in this run
   * @param minRemaining stop when GitHub reports fewer remaining requests than this
   */
  constructor({ store, token = null, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), maxRequests = 60, minRemaining = 200 }) {
    this.store = store;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.maxRequests = maxRequests;
    this.minRemaining = minRemaining;
    this.requests = 0;
    this.notModified = 0;
    this.rate = { remaining: null, reset_at: null };
  }

  stats() {
    return { requests: this.requests, not_modified: this.notModified, rate: this.rate };
  }

  async get(path, { pick = (x) => x } = {}) {
    if (this.requests >= this.maxRequests) throw new UpstreamBudgetExhausted('run_request_budget');
    if (this.rate.remaining !== null && this.rate.remaining < this.minRemaining) {
      throw new UpstreamBudgetExhausted('github_rate_limit_floor', this.rate.reset_at);
    }
    const url = `${API}${path}`;
    const cached = this.store.one('SELECT etag, body_json FROM upstream_http_cache WHERE url = ?', url);
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'gta6-coordinator-upstream', 'x-github-api-version': '2022-11-28' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (cached?.etag) headers['if-none-match'] = cached.etag;
    this.requests++;
    let res;
    try {
      res = await this.fetchImpl(url, { headers });
    } catch (err) {
      return { ok: false, status: 0, error: `network: ${String(err?.message ?? err).slice(0, 200)}` };
    }
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    if (remaining !== null) this.rate.remaining = Number(remaining);
    if (reset !== null) this.rate.reset_at = Number(reset) * 1000;

    if (res.status === 304 && cached) {
      this.notModified++;
      return { ok: true, status: 304, data: JSON.parse(cached.body_json), cached: true };
    }
    const limited = res.status === 429 || (res.status === 403 && (res.headers.get('retry-after') || remaining === '0'));
    if (limited) {
      const retry = Number(res.headers.get('retry-after') ?? 0);
      const resumeAt = retry ? this.now() + retry * 1000 : this.rate.reset_at;
      throw new UpstreamBudgetExhausted(`github_rate_limited_${res.status}`, resumeAt);
    }
    if (res.status === 404) return { ok: false, status: 404, error: 'not_found' };
    if (!res.ok) return { ok: false, status: res.status, error: `http_${res.status}` };
    let data;
    try {
      data = pick(await res.json());
    } catch {
      return { ok: false, status: res.status, error: 'bad_json' };
    }
    const etag = res.headers.get('etag');
    if (etag) {
      this.store.exec(
        `INSERT INTO upstream_http_cache (url, etag, body_json, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET etag = excluded.etag, body_json = excluded.body_json, fetched_at = excluded.fetched_at`,
        url, etag, JSON.stringify(data), this.now(),
      );
    }
    return { ok: true, status: res.status, data, cached: false };
  }

  repo(repo) {
    return this.get(`/repos/${repo}`, { pick: (r) => ({ default_branch: r.default_branch, archived: !!r.archived, pushed_at: r.pushed_at }) });
  }

  headCommit(repo, branch) {
    return this.get(`/repos/${repo}/commits/${encodeURIComponent(branch)}`, {
      pick: (c) => ({ sha: c.sha, committed_at: c.commit?.committer?.date ?? null, message: String(c.commit?.message ?? '').split('\n')[0].slice(0, 200) }),
    });
  }

  issue(repo, number) {
    return this.get(`/repos/${repo}/issues/${number}`, {
      pick: (i) => ({
        number: i.number,
        title: i.title,
        html_url: i.html_url,
        state: i.state,
        state_reason: i.state_reason ?? null,
        closed_at: i.closed_at ?? null,
        updated_at: i.updated_at,
        is_pull_request: !!i.pull_request,
        merged_at: i.pull_request?.merged_at ?? null,
      }),
    });
  }

  pull(repo, number) {
    return this.get(`/repos/${repo}/pulls/${number}`, {
      pick: (p) => ({ number: p.number, html_url: p.html_url, state: p.state, merged: !!p.merged, merged_at: p.merged_at ?? null, merge_commit_sha: p.merge_commit_sha ?? null, updated_at: p.updated_at }),
    });
  }

  /** Who/what closed an issue: closing commit and cross-referencing PRs (evidence, never a verdict). */
  timeline(repo, number) {
    return this.get(`/repos/${repo}/issues/${number}/timeline?per_page=100`, {
      pick: (events) =>
        (Array.isArray(events) ? events : [])
          .filter((e) => e.event === 'closed' || e.event === 'reopened' || (e.event === 'cross-referenced' && e.source?.issue?.pull_request))
          .map((e) => ({
            event: e.event,
            at: e.created_at ?? null,
            commit_id: e.commit_id ?? null,
            pr: e.source?.issue?.pull_request ? { url: e.source.issue.html_url, merged_at: e.source.issue.pull_request.merged_at ?? null, state: e.source.issue.state } : null,
          }))
          .slice(-20),
    });
  }

  /** Blob sha of a file at a ref (changes whenever the content changes). */
  file(repo, path, ref) {
    const p = path.split('/').map(encodeURIComponent).join('/');
    return this.get(`/repos/${repo}/contents/${p}?ref=${encodeURIComponent(ref)}`, {
      pick: (f) => ({ sha: f.sha, size: f.size, path: f.path, html_url: f.html_url, headings: markdownHeadings(f) }),
    });
  }

  /** Commits touching a path since a timestamp (evidence for "the cited source changed"). */
  commitsForPath(repo, path, sinceIso, ref) {
    return this.get(`/repos/${repo}/commits?path=${encodeURIComponent(path)}&since=${encodeURIComponent(sinceIso)}&sha=${encodeURIComponent(ref)}&per_page=10`, {
      pick: (list) =>
        (Array.isArray(list) ? list : []).map((c) => ({
          sha: c.sha,
          committed_at: c.commit?.committer?.date ?? null,
          message: String(c.commit?.message ?? '').split('\n')[0].slice(0, 200),
          url: c.html_url,
        })),
    });
  }
}
