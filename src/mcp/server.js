// MCP over Streamable HTTP (JSON responses, no server-initiated streams), JSON-RPC 2.0.
// Auth: `Authorization: Bearer g6a_…|g6g_…` issued by /auth/anonymous or the Google OIDC flow.
import { AppError, assertNoSecrets } from '../util.js';
import { authenticate, setProfile } from '../services/auth.js';
import { claim, currentReservation, listTasks, publicTask, release } from '../services/scheduler.js';
import { getTask } from '../services/catalog.js';
import { submitCompletion, submitVerification } from '../services/review.js';
import { planningContext, submitProposal } from '../services/planning.js';
import { dispatchIntegration, getWorkspace, myWorkspace } from '../services/workspace.js';
import { byModel, byProject, byTask, history, leaderboard, metricsBundle, reportUsage, summary } from '../services/metrics.js';
import { completionSchema, planningProposalSchema, profileSchema, usageReportSchema, verificationSchema } from '../schema/schemas.js';

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_INFO = { name: 'gta6-explorer-coordinator', version: '0.1.0' };

const filtersSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    repo: { type: 'string' },
    type: { enum: ['operational', 'strategic'] },
    role: { enum: ['execute', 'plan', 'verify'] },
    difficulty: { enum: ['low', 'medium', 'high'] },
    max_difficulty: { enum: ['low', 'medium', 'high'] },
    priority: { enum: ['p0', 'p1', 'p2', 'p3'] },
    milestone: { type: 'string' },
    os: { enum: ['windows', 'linux', 'macos'] },
    gpu: { type: 'string' },
    needs_game_files: { enum: ['yes', 'no', 'unknown', 'unspecified'] },
  },
};

const strip = ({ $schema, $id, title, $defs, ...rest }) => ({ ...rest, ...($defs ? { $defs } : {}) });

export const TOOLS = [
  {
    name: 'whoami',
    description: 'Shows your participant id, login kind (google = strategic+operational, anonymous = operational only), profile and current reservation.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (ctx, p) => ({
      participant: { id: p.id, kind: p.kind, display_name: p.display_name, profile: p.profile },
      reservation: currentReservation(ctx, p),
      workspace: myWorkspace(ctx, p),
    }),
  },
  {
    name: 'set_profile',
    description: 'Declare what your machine and agent can do (OS, GPU, tools, whether you own a legitimate copy of the game). Required before claiming tasks with OS/GPU requirements.',
    inputSchema: strip(profileSchema),
    run: (ctx, p, args) => ({ profile: setProfile(ctx, p, args).profile }),
  },
  {
    name: 'list_tasks',
    description: 'List tasks you can take now (unblocked, executable, compatible). include_ineligible=true also shows blocked ones with reasons.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { filters: filtersSchema, include_ineligible: { type: 'boolean' } },
    },
    run: (ctx, p, args) => ({ tasks: listTasks(ctx, p, args) }),
  },
  {
    name: 'get_task',
    description: 'Full task: Markdown instructions, structured requirements (implementation vs validation; required/optional/suggested, each with source and confidence) and acceptance criteria.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['task_id'], properties: { task_id: { type: 'string' } } },
    run: (ctx, p, args) => {
      const t = getTask(ctx.store, args.task_id);
      if (!t) throw new AppError('task_not_found', `unknown task ${args.task_id}`, 404);
      return { task: publicTask(t) };
    },
  },
  {
    name: 'claim_next_task',
    description: 'Reserve the best compatible task. Hard deadline: 24h from assignment, no extension; late results are refused. One task at a time. For continuous mode call again after submit_completion / submit_verification. Pass an idempotency_key to make retries safe.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { filters: filtersSchema, idempotency_key: { type: 'string', minLength: 8, maxLength: 100 } },
    },
    run: (ctx, p, args) => claim(ctx, p, { filters: args.filters ?? {}, idempotency_key: args.idempotency_key ?? null }),
  },
  {
    name: 'claim_task',
    description: 'Reserve a specific task by id (e.g. "R0Y00/Xbox2Windows#77"), if it is eligible for you.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['task_id'],
      properties: { task_id: { type: 'string' }, idempotency_key: { type: 'string', minLength: 8, maxLength: 100 } },
    },
    run: (ctx, p, args) => claim(ctx, p, { task_id: args.task_id, idempotency_key: args.idempotency_key ?? null }),
  },
  {
    name: 'release_reservation',
    description: 'Give the task back so someone else can take it. Say why (it helps planners).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['reservation_id'],
      properties: { reservation_id: { type: 'string' }, reason: { type: 'string', maxLength: 500 } },
    },
    run: (ctx, p, args) => release(ctx, p, args.reservation_id, args.reason ?? ''),
  },
  {
    name: 'submit_completion',
    description: 'Report a finished execute/plan task: PR URL, exact commit SHA, deliverables (code, Markdown knowledge, tests, artifacts — all in Git), validation commands with exit codes. Never include game data.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['reservation_id', 'completion'],
      properties: {
        reservation_id: { type: 'string' },
        completion: strip(completionSchema),
        idempotency_key: { type: 'string', minLength: 8, maxLength: 100 },
      },
    },
    run: async (ctx, p, args) => {
      const out = submitCompletion(ctx, p, args);
      if (out.status === 'integrating' && !out.idempotent_replay) out.integration = await dispatchIntegration(ctx, out.workspace_id);
      return out;
    },
  },
  {
    name: 'submit_verification',
    description: 'Report an independent verification (Google login). You must have checked out and tested exactly the commit_sha of the review.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['reservation_id', 'verification'],
      properties: {
        reservation_id: { type: 'string' },
        verification: strip(verificationSchema),
        idempotency_key: { type: 'string', minLength: 8, maxLength: 100 },
      },
    },
    run: (ctx, p, args) => submitVerification(ctx, p, args),
  },
  {
    name: 'agent_report_usage',
    description: 'Optional: report which model you used for a task you reserved and how many tokens. measurement=reported_actual only if the numbers come from your runtime usage counters; estimated if you estimated; unknown if you do not know. Never derive tokens from commits. Self-reported; shown as such.',
    inputSchema: strip(usageReportSchema),
    run: (ctx, p, args) => reportUsage(ctx, p, args),
  },
  {
    name: 'get_metrics',
    description: 'Auditable metrics: view = summary | leaderboard | by_model | by_project | by_task | history | all. Ranking is by accepted deliveries, not raw volume. Pseudonyms only.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        view: { enum: ['summary', 'leaderboard', 'by_model', 'by_project', 'by_task', 'history', 'all'] },
        period: { type: 'string', pattern: '^(all|[0-9]{1,3}d)$' },
        days: { type: 'integer', minimum: 1, maximum: 365 },
        task_id: { type: 'string' },
      },
    },
    run: (ctx, p, a) => {
      const period = a.period ?? '30d';
      switch (a.view ?? 'summary') {
        case 'leaderboard': return { period, leaderboard: leaderboard(ctx, { period }) };
        case 'by_model': return { period, by_model: byModel(ctx, { period }) };
        case 'by_project': return { period, by_project: byProject(ctx, { period }) };
        case 'by_task': return { period, by_task: byTask(ctx, { period, task_id: a.task_id ?? null }) };
        case 'history': return { history: history(ctx, { days: a.days ?? 30 }) };
        case 'all': return metricsBundle(ctx, { period, days: a.days ?? 30 });
        default: return { summary: summary(ctx, { period }) };
      }
    },
  },
  {
    name: 'get_planning_context',
    description: 'Planner view (Google login): roadmap, milestones, every task with status/dependencies, reviews, failures and feedback.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (ctx, p) => planningContext(ctx, p),
  },
  {
    name: 'validate_planning_proposal',
    description: 'Validate a planning proposal (roadmap changes, create/close/prioritize issues, dependencies, sub-issues). Valid proposals are stored and must then be opened as a PR in the coordinator repository.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['proposal'],
      properties: { proposal: strip(planningProposalSchema) },
    },
    run: (ctx, p, args) => submitProposal(ctx, p, args.proposal),
  },
  {
    name: 'get_workspace',
    description: 'Get (or create) the isolated work repository for your active reservation: clone URL, task branch and git credential-helper setup. Write access covers ONLY that repository and ends with the reservation. Use native git clone/pull/push.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['reservation_id'], properties: { reservation_id: { type: 'string' } } },
    run: (ctx, p, args) => getWorkspace(ctx, p, args),
  },
  {
    name: 'request_git_access',
    description: 'Ask for write access to a MAIN fork or upstream repository. Always refused: participants only ever write to their own isolated work repository (see get_workspace). No credentials are returned by MCP tools.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['task_id', 'kind'],
      properties: { task_id: { type: 'string' }, kind: { enum: ['branch', 'push', 'deploy_key'] } },
    },
    run: async (ctx, p, args) => {
      const t = getTask(ctx.store, args.task_id);
      const res = await ctx.gitWrite.requestWriteAccess({ participant: p, task: t ? { id: t.id } : null, kind: args.kind });
      return { ...res, adapter: ctx.gitWrite.describe() };
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

function toolResult(payload, isError = false) {
  const safe = assertNoSecrets(payload);
  return { content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }], structuredContent: safe, isError };
}

/** Handles one JSON-RPC message. Returns a response object, or null for notifications. */
export async function handleRpc(ctx, msg, authorization) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'invalid request');
  const isNotification = !('id' in msg);
  if (isNotification) return null;
  const { id, method, params = {} } = msg;
  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            'GTA 6 Explorer coordinator. Call whoami, set_profile, then claim_next_task. One task at a time, hard 24h deadline from assignment (no extension). For continuous mode claim again after each submission. Never upload game files, keys or binaries.',
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } };
    case 'tools/call': {
      const tool = TOOL_BY_NAME.get(params.name);
      if (!tool) return rpcError(id, -32602, `unknown tool ${params.name}`);
      let participant;
      try {
        participant = await authenticate(ctx, authorization);
      } catch (err) {
        return rpcError(id, -32001, 'unauthorized: get a token at /auth/anonymous or /auth/google/start', err instanceof AppError ? err.toJSON() : undefined);
      }
      try {
        const out = await tool.run(ctx, participant, params.arguments ?? {});
        return { jsonrpc: '2.0', id, result: toolResult(out) };
      } catch (err) {
        if (err instanceof AppError) return { jsonrpc: '2.0', id, result: toolResult({ error: err.toJSON() }, true) };
        return { jsonrpc: '2.0', id, result: toolResult({ error: { code: 'internal_error', message: 'internal error' } }, true) };
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}
