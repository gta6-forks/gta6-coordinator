import test from 'node:test';
import assert from 'node:assert/strict';
import { anon, baseEnv, google, HOUR, setup } from './helpers.js';
import { UpstreamReader } from '../src/github/upstream-reader.js';
import { checkUpstream, ensureFresh, recordVerdict, scheduledUpstreamCheck, upstreamReport } from '../src/services/upstream.js';
import { claim, currentReservation, listTasks } from '../src/services/scheduler.js';
import { validateProposal, catalogSnapshot, planningContext } from '../src/services/planning.js';
import { handleRpc } from '../src/mcp/server.js';
import { getMeta } from '../src/store/store.js';

const X2W = 'R0Y00/Xbox2Windows';
const RPF = 'breadbbbb/rpf9-explorer';
const SCX = 'Freminet/ScarlettX';
const REPOS = ['ItsNotRexed/Leonida', X2W, SCX, RPF, 'realdody/americas-recomp'];
const hex = (c) => c.repeat(40);

/** A tiny fake of the GitHub REST API (read side) with ETags and rate-limit headers. */
function fakeGitHub() {
  const st = {
    heads: Object.fromEntries(REPOS.map((r, i) => [r, { sha: hex(String(i + 1)), date: '2026-11-21T10:00:00Z' }])),
    issues: {}, // "repo#n" -> issue
    files: {}, // "repo:path" -> blob sha (default: stable)
    content: {}, // "repo:path" -> markdown text (optional)
    commits: {}, // "repo:path" -> list
    timeline: {},
    fail: {}, // repo -> status
    rateLimited: false,
    remaining: 4000,
    calls: [],
  };
  const issue = (repo, n) =>
    st.issues[`${repo}#${n}`] ?? { number: n, title: `#${n}`, html_url: `https://github.com/${repo}/issues/${n}`, state: 'open', state_reason: null, closed_at: null, updated_at: '2026-11-21T09:00:00Z' };
  const route = (path) => {
    let m;
    if ((m = /^\/repos\/([^/]+\/[^/]+)$/.exec(path))) return { default_branch: 'main', archived: false, pushed_at: st.heads[m[1]].date };
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/commits\/main$/.exec(path))) return { sha: st.heads[m[1]].sha, commit: { committer: { date: st.heads[m[1]].date }, message: 'head' } };
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/timeline/.exec(path))) return st.timeline[`${m[1]}#${m[2]}`] ?? [];
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(path))) return issue(m[1], Number(m[2]));
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(path))) {
      const i = issue(m[1], Number(m[2]));
      return { number: i.number, html_url: i.html_url, state: i.state, merged: !!i.pull_request?.merged_at, merged_at: i.pull_request?.merged_at ?? null, merge_commit_sha: hex('f'), updated_at: i.updated_at };
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)\?ref=/.exec(path))) {
      const key = `${m[1]}:${decodeURIComponent(m[2])}`;
      if (st.files[key] === null) return 404;
      const md = st.content[key];
      return { sha: st.files[key] ?? hex('0'), size: 10, path: decodeURIComponent(m[2]), html_url: 'x', ...(md ? { encoding: 'base64', content: Buffer.from(md).toString('base64') } : {}) };
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/commits\?path=([^&]+)/.exec(path))) return st.commits[`${m[1]}:${decodeURIComponent(m[2])}`] ?? [];
    return 404;
  };
  const fetch = async (url, { headers }) => {
    const path = url.replace('https://api.github.com', '');
    st.calls.push(path);
    const repo = /^\/repos\/([^/]+\/[^/?]+)/.exec(path)?.[1];
    const h = (extra = {}) => new Headers({ 'x-ratelimit-remaining': String(st.remaining), 'x-ratelimit-reset': '1795330218', ...extra });
    if (st.rateLimited) return new Response('{"message":"rate"}', { status: 403, headers: h({ 'x-ratelimit-remaining': '0' }) });
    if (st.fail[repo]) return new Response('{}', { status: st.fail[repo], headers: h() });
    const body = route(path);
    if (body === 404) return new Response('{"message":"Not Found"}', { status: 404, headers: h() });
    const text = JSON.stringify(body);
    const etag = `"${text.length}-${[...text].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)}"`;
    if (headers['if-none-match'] === etag) return new Response(null, { status: 304, headers: h({ etag }) });
    return new Response(text, { status: 200, headers: h({ etag, 'content-type': 'application/json' }) });
  };
  return { st, fetch };
}

async function world(mode = 'report', extraEnv = {}) {
  const gh = fakeGitHub();
  const s = await setup({ env: baseEnv({ UPSTREAM_RECONCILIATION: mode, ...extraEnv }) });
  s.ctx.upstreamReaderFactory = (o) => new UpstreamReader({ ...o, fetchImpl: gh.fetch });
  return { ...s, gh };
}

function closeIssue(gh, repo, n, reason = 'completed') {
  gh.st.issues[`${repo}#${n}`] = { number: n, title: `#${n}`, html_url: `https://github.com/${repo}/issues/${n}`, state: 'closed', state_reason: reason, closed_at: '2026-11-21T18:14:16Z', updated_at: '2026-11-21T18:14:16Z' };
  gh.st.timeline[`${repo}#${n}`] = [{ event: 'closed', created_at: '2026-11-21T18:14:16Z', commit_id: hex('c') }];
}
function mergePr(gh, repo, n) {
  gh.st.issues[`${repo}#${n}`] = { number: n, title: `#${n}`, html_url: `https://github.com/${repo}/pull/${n}`, state: 'closed', state_reason: null, closed_at: '2026-11-21T23:20:42Z', updated_at: '2026-11-21T23:20:42Z', pull_request: { merged_at: '2026-11-21T23:20:42Z' } };
}

const statusOf = (ctx, id) => upstreamReport(ctx, { task_id: id }).tasks[0];

test('records HEAD sha + timestamp per upstream and evidence per task; report mode never blocks', async () => {
  const { ctx, gh } = await world('report');
  closeIssue(gh, X2W, 77);
  const run = await checkUpstream(ctx, { reason: 'test' });
  assert.equal(run.partial, false);
  assert.equal(run.repos[X2W].head_sha, hex('2'));
  const r = upstreamReport(ctx);
  assert.equal(r.repos.find((x) => x.repo === X2W).head_sha, hex('2'));
  assert.ok(r.repos.every((x) => x.last_success_at));
  const t77 = statusOf(ctx, 'R0Y00/Xbox2Windows#77');
  assert.equal(t77.status, 'resolved_upstream');
  assert.equal(t77.provisional, true, 'automatic: a planner must confirm against the acceptance criteria');
  assert.ok(t77.reasons.includes('source_issue_closed_completed:#77'));
  assert.ok(t77.evidence.some((e) => e.kind === 'commit' && e.ref === hex('c')), 'closing commit recorded as evidence');
  assert.equal(t77.basis_sha, hex('2'));
  // report mode: still distributed, but every agent sees the warning
  const a = await anon(ctx);
  const listed = listTasks(ctx, a.participant).find((t) => t.id === 'R0Y00/Xbox2Windows#77');
  assert.ok(listed, 'not blocked in report mode');
  assert.match(listed.upstream.warning, /resolved_upstream/);
  // the workflow status is never changed by the reconciler
  assert.equal(ctx.store.one("SELECT status FROM tasks WHERE id = 'R0Y00/Xbox2Windows#77'").status, 'open');
});

test('enforce_evidence: resolved/obsolete upstream is not distributed; a dependency resolved upstream unblocks only after a planner verdict', async () => {
  const { ctx, gh } = await world('enforce_evidence');
  closeIssue(gh, X2W, 77);
  mergePr(gh, RPF, 1);
  await checkUpstream(ctx);
  const g = await google(ctx, { os: ['windows'], gpu_vendor: 'none' });
  const all = listTasks(ctx, g.participant, { include_ineligible: true });
  const t77 = all.find((t) => t.id === 'R0Y00/Xbox2Windows#77');
  assert.ok(t77.ineligible_reasons.includes('upstream:resolved_upstream'));
  assert.ok(all.find((t) => t.id === 'breadbbbb/rpf9-explorer#1').ineligible_reasons.includes('upstream:resolved_upstream'));
  const leonida = all.find((t) => t.id === 'ItsNotRexed/Leonida#29');
  assert.ok(leonida.ineligible_reasons.includes('blocked_by:breadbbbb/rpf9-explorer#1'), 'automatic signal alone does not unblock dependents');
  {
    const id = 'breadbbbb/rpf9-explorer#1';
    const acc = JSON.parse(ctx.store.one('SELECT data_json FROM tasks WHERE id = ?', id).data_json).acceptance.length;
    await recordVerdict(ctx, g.participant, {
      task_id: id, status: 'resolved_upstream', basis_sha: statusOf(ctx, id).basis_sha,
      criteria: Array.from({ length: acc }, (_, index) => ({ index, met: 'yes', evidence: [{ kind: 'pr', ref: 'https://github.com/breadbbbb/rpf9-explorer/pull/1' }] })),
    });
    const again = listTasks(ctx, g.participant, { include_ineligible: true }).find((t) => t.id === 'ItsNotRexed/Leonida#29');
    assert.ok(!again.ineligible_reasons.some((r) => r.startsWith('blocked_by')), 'planner-confirmed resolution => dependency satisfied');
  }
  assert.throws(() => claim(ctx, g.participant, { task_id: 'R0Y00/Xbox2Windows#77' }), (e) => e.details.reasons.includes('upstream:resolved_upstream'));
  // not-planned => obsolete
  closeIssue(gh, X2W, 126, 'not_planned');
  await checkUpstream(ctx, { force: true });
  assert.equal(statusOf(ctx, 'R0Y00/Xbox2Windows#126').status, 'obsolete');
});

test('a task reserved by someone else is flagged, never cancelled', async () => {
  const { ctx, gh } = await world('enforce_evidence');
  const a = await anon(ctx);
  await checkUpstream(ctx);
  assert.equal(claim(ctx, a.participant, { task_id: 'R0Y00/Xbox2Windows#77' }).status, 'reserved');
  closeIssue(gh, X2W, 77);
  await checkUpstream(ctx, { force: true });
  const cur = currentReservation(ctx, a.participant);
  assert.equal(cur.status, 'active', 'reservation untouched');
  assert.equal(cur.task.upstream.status, 'resolved_upstream');
  assert.match(cur.task.upstream.warning, /get_upstream_status/);
  assert.ok(ctx.store.one("SELECT 1 AS x FROM events WHERE type = 'upstream.reserved_task_flagged'"));
});

test('cited file changed upstream => needs_review with commit evidence; blocks only in full enforce', async () => {
  const { ctx, gh } = await world('enforce_evidence');
  await checkUpstream(ctx); // baseline
  gh.st.files[`${SCX}:README.md`] = hex('9');
  gh.st.commits[`${SCX}:README.md`] = [{ sha: hex('7'), commit: { committer: { date: '2026-11-22T01:00:00Z' }, message: 'Fix child process boot' }, html_url: 'u' }];
  ctx.now.advance(HOUR);
  await checkUpstream(ctx, { force: true });
  const t = statusOf(ctx, 'draft:Freminet/ScarlettX/child-process-boot');
  assert.equal(t.status, 'needs_review');
  assert.ok(t.reasons.includes('source_file_changed:README.md'));
  assert.ok(t.evidence.some((e) => e.kind === 'commit' && e.ref === hex('7')));
  assert.equal(t.would_block, false, 'a change is a reason to revalidate, not proof of resolution');
  // full enforce: unrevalidated or stale tasks are held back too
  ctx.env.UPSTREAM_RECONCILIATION = 'enforce';
  const g = await google(ctx, { os: ['windows'], gpu_vendor: 'none' });
  ctx.now.advance(7 * HOUR); // past UPSTREAM_MAX_STALENESS_MINUTES (6h)
  const t77 = listTasks(ctx, g.participant, { include_ineligible: true }).find((x) => x.id === 'R0Y00/Xbox2Windows#77');
  assert.ok(t77.ineligible_reasons.includes(`upstream_stale:${X2W}`));
});

test('verdicts: must use current HEAD, address every acceptance criterion, and cite commit/PR/file evidence', async () => {
  const { ctx, gh } = await world('enforce_evidence');
  closeIssue(gh, X2W, 77);
  await checkUpstream(ctx);
  const a = await anon(ctx);
  const g = await google(ctx);
  const id = 'R0Y00/Xbox2Windows#77';
  const n = ctx.store.one('SELECT data_json FROM tasks WHERE id = ?', id);
  const acc = JSON.parse(n.data_json).acceptance.length;
  const yes = (ev) => Array.from({ length: acc }, (_, index) => ({ index, met: 'yes', evidence: ev }));
  await assert.rejects(() => recordVerdict(ctx, a.participant, { task_id: id, status: 'valid', basis_sha: hex('2'), criteria: [] }), /Google/);
  await assert.rejects(() => recordVerdict(ctx, g.participant, { task_id: id, status: 'resolved_upstream', basis_sha: hex('1'), criteria: yes([]) }), (e) => e.code === 'upstream_moved');
  await assert.rejects(
    () => recordVerdict(ctx, g.participant, { task_id: id, status: 'resolved_upstream', basis_sha: hex('2'), criteria: yes([{ kind: 'issue', ref: 'https://github.com/R0Y00/Xbox2Windows/issues/77' }]) }),
    (e) => e.code === 'verdict_invalid' && e.details.errors.some((x) => /not evidence/.test(x)),
  );
  await assert.rejects(
    () => recordVerdict(ctx, g.participant, { task_id: id, status: 'resolved_upstream', basis_sha: hex('2'), criteria: yes([{ kind: 'commit', ref: hex('c') }]).slice(1) }),
    (e) => e.details.errors.some((x) => /every acceptance criterion/.test(x)),
  );
  // Planner finds the criteria NOT met upstream (issue closed for another reason): task stays valid and distributable.
  const ok = await recordVerdict(ctx, g.participant, {
    task_id: id, status: 'valid', basis_sha: hex('2'),
    criteria: Array.from({ length: acc }, (_, index) => ({ index, met: 'no', evidence: [] })),
    rationale_md: 'Closed upstream but the relocation test from the acceptance criteria does not exist there.',
  });
  assert.equal(ok.status, 'valid');
  let t = statusOf(ctx, id);
  assert.equal(t.status, 'valid');
  assert.equal(t.source, 'planner');
  assert.equal(t.would_block, false);
  // New upstream signal after the verdict => back to automatic + revalidation_required
  gh.st.timeline[`${X2W}#77`].push({ event: 'cross-referenced', created_at: '2026-11-22T02:00:00Z', source: { issue: { html_url: `https://github.com/${X2W}/pull/500`, state: 'closed', pull_request: { merged_at: '2026-11-22T02:00:00Z' } } } });
  await checkUpstream(ctx, { force: true });
  t = statusOf(ctx, id);
  assert.equal(t.source, 'automatic');
  assert.equal(t.revalidation_required, true);
  // history is append-only
  assert.equal(ctx.store.one('SELECT COUNT(*) AS n FROM upstream_verdicts').n, 1);
});

test('rate limit: run stops, backoff is stored, last good snapshot kept; 5xx backs off per repo', async () => {
  const { ctx, gh } = await world('report');
  await checkUpstream(ctx);
  const before = ctx.store.one('SELECT head_sha, last_success_at FROM upstream_repos WHERE repo = ?', X2W);
  gh.st.rateLimited = true;
  ctx.now.advance(HOUR);
  const run = await checkUpstream(ctx, { force: true });
  assert.equal(run.partial, true);
  assert.match(run.stopped, /rate_limited/);
  assert.ok(getMeta(ctx.store, 'upstream_backoff_until', 0) > 0);
  assert.deepEqual(ctx.store.one('SELECT head_sha, last_success_at FROM upstream_repos WHERE repo = ?', X2W), before);
  assert.equal((await checkUpstream(ctx)).skipped, 'github_rate_limit_backoff');

  const w2 = await world('report');
  w2.gh.st.fail[X2W] = 502;
  const r2 = await checkUpstream(w2.ctx);
  assert.equal(r2.repos[X2W].error, 'http_502');
  const row = w2.ctx.store.one('SELECT consecutive_failures, next_check_after FROM upstream_repos WHERE repo = ?', X2W);
  assert.equal(row.consecutive_failures, 1);
  assert.ok(row.next_check_after > w2.ctx.now());
  assert.equal((await checkUpstream(w2.ctx)).repos[X2W].skipped, 'failure_backoff');
});

test('conditional requests: a second run is served by 304s; cron honours the interval; precheck only when stale', async () => {
  const { ctx, gh } = await world('report');
  const first = await checkUpstream(ctx);
  assert.ok(first.http.not_modified < first.http.requests, 'first run fetches (repeat URLs in one run revalidate)');
  ctx.now.advance(HOUR);
  const second = await checkUpstream(ctx, { force: true });
  assert.equal(second.http.not_modified, second.http.requests, 'nothing changed => all 304');
  assert.equal((await scheduledUpstreamCheck(ctx)).skipped, 'interval', 'a full run just happened');
  ctx.now.advance(HOUR);
  assert.equal((await scheduledUpstreamCheck(ctx)).skipped, undefined); // 1h > 30 min
  assert.equal((await scheduledUpstreamCheck(ctx)).skipped, 'interval');
  const calls = gh.st.calls.length;
  assert.deepEqual(await ensureFresh(ctx), { fresh: true });
  assert.equal(gh.st.calls.length, calls, 'fresh snapshot => no request before claim');
});

test('planning: sees the upstream, cannot keep resolved tasks in stock, and respects the stock limit', async () => {
  const { ctx, gh } = await world('enforce_evidence', { UPSTREAM_MAX_STOCK_PER_REPO: '1' });
  closeIssue(gh, X2W, 77);
  await checkUpstream(ctx);
  const g = await google(ctx);
  const pc = planningContext(ctx, g.participant);
  assert.equal(pc.upstream.mode, 'enforce_evidence');
  assert.ok(pc.upstream.tasks.some((t) => t.task_id === 'R0Y00/Xbox2Windows#77' && t.status === 'resolved_upstream'));
  const snap = catalogSnapshot(ctx.store, ctx.env, ctx.now());
  const base = (ops) => ({ schema_version: 1, id: 'plan-upstream-test', rationale_md: 'r', based_on: { roadmap_version: 1, snapshot_at: '2026-11-21T12:00:00Z' }, operations: ops });
  const bump = validateProposal(base([{ op: 'set_priority', id: 'R0Y00/Xbox2Windows#77', priority: 'p0' }]), snap);
  assert.ok(bump.errors.some((e) => /resolved_upstream upstream; close it/.test(e)), JSON.stringify(bump.errors));
  const close = validateProposal(base([{ op: 'close_issue', id: 'R0Y00/Xbox2Windows#77', reason_md: 'resolved upstream' }]), snap);
  assert.ok(!close.errors.some((e) => /upstream/.test(e)), 'closing is always allowed');
  const newTask = {
    kind: 'issue', type: 'operational', role: 'execute', difficulty: 'low', priority: 'p2', instructions_md: 'x',
    requirements: { implementation: { required: [], optional: [], suggested: [] }, validation: { required: [], optional: [], suggested: [] } },
    acceptance: [{ text: 'a', confidence: 'confirmed' }], deliverables: ['code'],
  };
  const two = validateProposal(base([
    { op: 'create_issue', ref: 'new:n1', repo: 'R0Y00/Xbox2Windows', title: 'Task A', body_md: 'b', task: newTask },
    { op: 'create_issue', ref: 'new:n2', repo: 'R0Y00/Xbox2Windows', title: 'Task B', body_md: 'b', task: newTask },
  ]), snap);
  assert.ok(two.errors.some((e) => /stock limit: xbox2windows/.test(e)), JSON.stringify(two.errors));
});

test('MCP: claim runs the upstream precheck; get_upstream_status is available; check_upstream needs Google', async () => {
  const { ctx, gh } = await world('enforce_evidence');
  closeIssue(gh, X2W, 77);
  const a = await anon(ctx);
  const call = (name, args = {}, token = a.token) => handleRpc(ctx, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, `Bearer ${token}`);
  const r = await call('claim_task', { task_id: 'R0Y00/Xbox2Windows#77' });
  assert.equal(r.result.isError, true);
  assert.ok(r.result.structuredContent.error.details.reasons.includes('upstream:resolved_upstream'), 'precheck fetched the upstream before claiming');
  const s = await call('get_upstream_status', { task_id: 'R0Y00/Xbox2Windows#77' });
  assert.equal(s.result.structuredContent.tasks[0].status, 'resolved_upstream');
  const c = await call('check_upstream');
  assert.equal(c.result.structuredContent.error.code, 'requires_google_login');
});

test('the cited README section disappearing upstream => needs_replan (not just "file changed")', async () => {
  const { ctx, gh } = await world('enforce_evidence');
  gh.st.content[`${SCX}:README.md`] = '# ScarlettX\n## Status\n## Current Limitations\n';
  await checkUpstream(ctx);
  assert.equal(statusOf(ctx, 'draft:Freminet/ScarlettX/child-process-boot').status, 'valid');
  gh.st.files[`${SCX}:README.md`] = hex('8');
  gh.st.content[`${SCX}:README.md`] = '# ScarlettX\n## Status\n';
  gh.st.commits[`${SCX}:README.md`] = [{ sha: hex('6'), commit: { committer: { date: '2026-11-22T01:00:00Z' }, message: 'Remove limitations' }, html_url: 'u' }];
  ctx.now.advance(HOUR);
  await checkUpstream(ctx, { force: true });
  const t = statusOf(ctx, 'draft:Freminet/ScarlettX/child-process-boot');
  assert.equal(t.status, 'needs_replan');
  assert.ok(t.reasons.includes('source_section_removed:README.md#Current Limitations'));
  assert.equal(statusOf(ctx, 'draft:Freminet/ScarlettX/failing-tests').status, 'needs_review', '"Status" section still there');
});

test('report mode: planning gets warnings instead of upstream errors, and claims never wait on GitHub', async () => {
  const { ctx, gh } = await world('report', { UPSTREAM_MAX_STOCK_PER_REPO: '1' });
  closeIssue(gh, X2W, 77);
  await checkUpstream(ctx);
  const snap = catalogSnapshot(ctx.store, ctx.env, ctx.now());
  assert.equal(snap.upstream.mode, 'report');
  const base = (ops) => ({ schema_version: 1, id: 'plan-upstream-report', rationale_md: 'r', based_on: { roadmap_version: 1, snapshot_at: '2026-11-21T12:00:00Z' }, operations: ops });
  const bump = validateProposal(base([{ op: 'set_priority', id: 'R0Y00/Xbox2Windows#77', priority: 'p0' }]), snap);
  assert.ok(!bump.errors.some((e) => /upstream/.test(e)), JSON.stringify(bump.errors));
  assert.ok(bump.warnings.some((w) => /resolved_upstream upstream/.test(w)), JSON.stringify(bump.warnings));
  // a stale snapshot does not make the claim wait for GitHub in report mode
  ctx.now.advance(HOUR);
  const a = await anon(ctx);
  const before = ctx.store.one('SELECT last_attempt_at FROM upstream_repos WHERE repo = ?', 'R0Y00/Xbox2Windows').last_attempt_at;
  const r = await handleRpc(ctx, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'claim_task', arguments: { task_id: 'R0Y00/Xbox2Windows#77' } } }, `Bearer ${a.token}`);
  assert.notEqual(r.result.isError, true, 'report mode never blocks distribution');
  const after = ctx.store.one('SELECT last_attempt_at FROM upstream_repos WHERE repo = ?', 'R0Y00/Xbox2Windows').last_attempt_at;
  assert.equal(after, before, 'no upstream request on the claim path');
});


test('false positives/negatives: context sources, cross-repo files, never-seen files/sections, merged PR on an open origin', async () => {
  const { ctx, gh } = await world('enforce_evidence');
  const { sourceRefs } = await import('../src/services/upstream.js');
  // relation "context" is not an origin; a file from another known upstream is skipped
  const refs = sourceRefs({ id: 'draft:x', sources: [
    { kind: 'issue', ref: `https://github.com/${X2W}/issues/9`, relation: 'context' },
    { kind: 'issue', ref: `https://github.com/${X2W}/issues/10` },
    { kind: 'file', ref: 'rpf9-explorer/README.md' },
  ] }, X2W, [X2W, RPF]);
  assert.deepEqual(refs.issues.map((i) => [i.number, i.context]), [[9, true], [10, false]]);
  assert.equal(refs.files.length, 0);
  assert.deepEqual(refs.skipped, ['source_file_other_repo:rpf9-explorer/README.md']);
  // open origin issue with a PR merged after the task was written => partially_met (Xbox2Windows#126 / PR #134 case)
  gh.st.timeline[`${X2W}#126`] = [{ event: 'cross-referenced', created_at: '2026-11-21T17:00:00Z', source: { issue: { html_url: `https://github.com/${X2W}/pull/134`, state: 'closed', pull_request: { merged_at: '2026-11-21T17:57:31Z' } } } }];
  await checkUpstream(ctx);
  const t126 = statusOf(ctx, 'R0Y00/Xbox2Windows#126');
  assert.equal(t126.status, 'partially_met');
  assert.ok(t126.reasons.includes('source_issue_linked_pr_merged:#126'));
  assert.ok(t126.evidence.some((e) => e.kind === 'pr' && /pull\/134/.test(e.ref)));
});

test('a never-seen file or section asks for review instead of re-planning', async () => {
  const { ctx, gh } = await world('enforce_evidence');
  gh.st.content[`${SCX}:README.md`] = 'ScarlettX\n=========\nCurrent Limitations\n-------------------\n'; // setext headings
  await checkUpstream(ctx);
  const t = statusOf(ctx, 'draft:Freminet/ScarlettX/child-process-boot');
  assert.equal(t.status, 'needs_review');
  assert.ok(t.reasons.includes('source_section_not_found:README.md#Current Limitations'));
});
