#!/usr/bin/env node
// End-to-end smoke test against a running coordinator (wrangler dev or production).
//   node tools/smoke.mjs http://127.0.0.1:8787
// Creates ONE anonymous participant, reserves a task, reports usage, releases it. Prints a line per check.
const base = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`);
};
const getJson = async (path, init) => {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
};
let id = 0;
const rpc = (token, method, params = {}) =>
  getJson('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
const tool = async (token, name, args = {}) => (await rpc(token, 'tools/call', { name, arguments: args })).body.result;

const landing = await getJson('/');
check('landing served by static assets', landing.status === 200 && String(landing.body).includes('claude mcp add'));
check('landing has CSP header', Boolean(landing.headers.get('content-security-policy')));
const onboarding = await getJson('/onboarding.html');
check('onboarding page', onboarding.status === 200 && String(onboarding.body).includes('claim_next_task'));
const health = await getJson('/health');
check('health', health.status === 200 && health.body.ok === true, `provisioner=${health.body.workspaces?.name}`);
const cfg = await getJson('/api/config');
check('config', cfg.status === 200, `google_login=${cfg.body.google_login}`);
const tasks = await getJson('/api/tasks');
check('public catalog', tasks.status === 200 && tasks.body.tasks.length > 0, `${tasks.body.tasks?.length} tasks`);
const metrics0 = await getJson('/api/metrics?period=30d');
check('public metrics', metrics0.status === 200 && metrics0.body.summary !== undefined, `accepted=${metrics0.body.summary?.accepted}`);
check('internal routes blocked', (await getJson('/internal/sync', { method: 'POST' })).status === 404);
check('foreign origin refused on /mcp', (await getJson('/mcp', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' })).status === 403);

const init = await rpc(null, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
check('MCP initialize', init.body.result?.serverInfo?.name === 'gta6-explorer-coordinator', init.body.result?.protocolVersion);
const list = await rpc(null, 'tools/list');
const names = (list.body.result?.tools ?? []).map((t) => t.name);
check('MCP tools/list', names.includes('claim_next_task') && names.includes('agent_report_usage') && !names.includes('renew_reservation'), names.join(','));
check('MCP requires token for tools/call', (await rpc(null, 'tools/call', { name: 'whoami', arguments: {} })).body.error?.code === -32001);

const signup = await getJson('/auth/anonymous', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
check('anonymous sign-up', signup.status === 200 && /^g6a_/.test(signup.body.token ?? ''));
const token = signup.body.token;
const who = await tool(token, 'whoami');
check('whoami', who?.structuredContent?.participant?.kind === 'anonymous', who?.structuredContent?.participant?.display_name);
const prof = await tool(token, 'set_profile', { os: ['windows'], gpu_vendor: 'nvidia', has_own_game_copy: false, agent: 'smoke' });
check('set_profile', prof?.isError === false);
const claimed = await tool(token, 'claim_next_task', { idempotency_key: `smoke-${Date.now()}` });
const c = claimed?.structuredContent;
check('claim_next_task', c?.status === 'reserved', `${c?.task?.id} until ${c?.reservation?.expires_at}`);
check('hard 24h deadline, not renewable', c?.reservation?.renewable === false && c?.reservation?.hard_timeout === true);
const again = await tool(token, 'claim_next_task', {});
check('one task at a time', again?.structuredContent?.error?.code === 'active_reservation_exists');
const ws = await tool(token, 'get_workspace', { reservation_id: c.reservation.id });
check('get_workspace answers (provisioner state shown)', ws?.isError === false, `state=${ws?.structuredContent?.state} provisioner=${ws?.structuredContent?.provisioner?.name}`);
const cred = await getJson('/api/git/credential', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ host: 'github.com', path: 'R0Y00/Xbox2Windows.git' }),
});
check('no credential for a main/upstream repository', cred.status === 403, cred.body?.error?.code);
const usage = await tool(token, 'agent_report_usage', {
  report_id: `smoke-usage-${Date.now()}`,
  task_id: c.task.id,
  provider: 'smoke-test',
  model_id: 'none',
  measurement: 'unknown',
  method: 'none',
  source: 'tools/smoke.mjs (no model was used)',
  confidence: 'none',
});
check('agent_report_usage (unknown)', usage?.structuredContent?.status === 'recorded');
const m = await tool(token, 'get_metrics', { view: 'leaderboard', period: '1d' });
check('get_metrics leaderboard', Array.isArray(m?.structuredContent?.leaderboard), `${m?.structuredContent?.leaderboard?.length} rows`);
const rel = await tool(token, 'release_reservation', { reservation_id: c.reservation.id, reason: 'smoke test' });
check('release_reservation', rel?.structuredContent?.status === 'released');
const git = await tool(token, 'request_git_access', { task_id: c.task.id, kind: 'push' });
check('request_git_access denied for main repos', git?.structuredContent?.status === 'denied');

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
