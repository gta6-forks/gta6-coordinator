// Canonical schemas. `npm run build` exports them to /schemas/*.schema.json for external tools.
const ID_PATTERN =
  '^(([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[1-9][0-9]*)|(local:[a-z0-9][a-z0-9/_.-]*)|(draft:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/[a-z0-9-]+))$';
const REPO_PATTERN = '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$';
const SHA_PATTERN = '^[0-9a-f]{40}$';
const PR_URL_PATTERN = '^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[1-9][0-9]*$';

const confidence = { enum: ['confirmed', 'inferred', 'unspecified'] };

const requirementDefs = {
  confidence,
  requirement: {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'value', 'confidence'],
    properties: {
      kind: { enum: ['os', 'gpu', 'tool', 'game_files', 'hardware', 'skill', 'network', 'disk'] },
      value: {},
      detail: { type: 'string', maxLength: 500 },
      source: { type: 'string', maxLength: 300 },
      confidence: { $ref: '#/$defs/confidence' },
    },
  },
  phase: {
    type: 'object',
    additionalProperties: false,
    required: ['required', 'optional', 'suggested'],
    properties: {
      required: { type: 'array', items: { $ref: '#/$defs/requirement' } },
      optional: { type: 'array', items: { $ref: '#/$defs/requirement' } },
      suggested: { type: 'array', items: { $ref: '#/$defs/requirement' } },
    },
  },
  requirements: {
    type: 'object',
    additionalProperties: false,
    required: ['implementation', 'validation'],
    properties: { implementation: { $ref: '#/$defs/phase' }, validation: { $ref: '#/$defs/phase' } },
  },
};

export const taskSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://gta6-explorer.invalid/schemas/task.schema.json',
  title: 'GTA 6 Explorer coordinator task',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'kind', 'type', 'role', 'difficulty', 'priority', 'readiness', 'state', 'depends_on',
    'instructions_md', 'requirements', 'acceptance', 'deliverables', 'sources'],
  properties: {
    id: { type: 'string', pattern: ID_PATTERN },
    repo: { type: ['string', 'null'], pattern: REPO_PATTERN },
    fork_repo: { type: ['string', 'null'], pattern: REPO_PATTERN },
    github_kind: { enum: ['issue', 'pull_request', null] },
    url: { type: ['string', 'null'], maxLength: 300 },
    title: { type: 'string', minLength: 3, maxLength: 200 },
    kind: { enum: ['issue', 'subissue', 'group'] },
    parent: { type: ['string', 'null'], pattern: ID_PATTERN },
    type: { enum: ['operational', 'strategic'] },
    role: { enum: ['execute', 'plan', 'verify'] },
    difficulty: { enum: ['low', 'medium', 'high'] },
    difficulty_source: { enum: ['estimate', 'maintainer'] },
    priority: { enum: ['p0', 'p1', 'p2', 'p3'] },
    readiness: { enum: ['draft', 'ready', 'needs_info', 'blocked_external'] },
    state: { enum: ['open', 'closed'] },
    milestone: { type: ['string', 'null'] },
    depends_on: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: ID_PATTERN } },
    instructions_md: { type: 'string', minLength: 1, maxLength: 20000 },
    requirements: { $ref: '#/$defs/requirements' },
    acceptance: { type: 'array', items: { $ref: '#/$defs/sourced_text' } },
    deliverables: {
      type: 'array',
      uniqueItems: true,
      items: { enum: ['code', 'knowledge_md', 'tests', 'artifacts', 'report', 'planning_proposal', 'verification_report'] },
    },
    sources: { type: 'array', minItems: 1, items: { $ref: '#/$defs/source' } },
    restrictions: { type: 'array', items: { type: 'string', maxLength: 300 } },
    review: {
      type: 'object',
      additionalProperties: false,
      required: ['review_id', 'target_task_id'],
      properties: {
        review_id: { type: 'string' },
        target_task_id: { type: 'string', pattern: ID_PATTERN },
        slot: { type: 'integer', minimum: 1, maximum: 2 },
        commit_sha: { type: 'string', pattern: SHA_PATTERN },
        pr_url: { type: 'string', pattern: PR_URL_PATTERN },
        executor_id: { type: 'string' },
      },
    },
  },
  $defs: {
    ...requirementDefs,
    source: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'ref'],
      properties: {
        kind: { enum: ['issue', 'pull_request', 'file', 'url', 'coordinator', 'user_decision'] },
        ref: { type: 'string', maxLength: 300 },
        heading: { type: 'string', maxLength: 200 },
        lines: { type: 'string', maxLength: 40 },
        retrieved_at: { type: 'string', maxLength: 40 },
      },
    },
    sourced_text: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'confidence'],
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 1000 },
        source: { type: 'string', maxLength: 300 },
        confidence: { $ref: '#/$defs/confidence' },
      },
    },
  },
};

export const profileSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://gta6-explorer.invalid/schemas/profile.schema.json',
  title: 'Participant capability profile (self-declared)',
  type: 'object',
  additionalProperties: false,
  required: ['os'],
  properties: {
    os: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: ['windows', 'linux', 'macos'] } },
    gpu_vendor: { enum: ['none', 'amd', 'nvidia', 'intel', 'apple', 'other'] },
    gpu_model: { type: 'string', maxLength: 100 },
    tools: { type: 'array', uniqueItems: true, maxItems: 50, items: { type: 'string', maxLength: 60 } },
    has_own_game_copy: { type: 'boolean' },
    accept_unknown_requirements: { type: 'boolean' },
    agent: { type: 'string', maxLength: 80 },
  },
};

const commandResult = {
  type: 'object',
  additionalProperties: false,
  required: ['command', 'exit_code'],
  properties: {
    command: { type: 'string', minLength: 1, maxLength: 1000 },
    exit_code: { type: 'integer' },
    summary: { type: 'string', maxLength: 4000 },
  },
};

const environment = {
  type: 'object',
  additionalProperties: false,
  required: ['os'],
  properties: {
    os: { type: 'string', maxLength: 100 },
    gpu: { type: 'string', maxLength: 100 },
    driver: { type: 'string', maxLength: 100 },
    toolchain: { type: 'string', maxLength: 300 },
  },
};

export const completionSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://gta6-explorer.invalid/schemas/completion.schema.json',
  title: 'Task completion reported to the MCP',
  type: 'object',
  additionalProperties: false,
  required: ['commit_sha', 'summary_md', 'deliverables', 'validation', 'ai_assisted', 'game_data_in_deliverables'],
  properties: {
    workspace_id: { type: 'string', pattern: '^ws_[0-9a-f]{16}$' },
    pr_url: { type: 'string', pattern: PR_URL_PATTERN },
    commit_sha: { type: 'string', pattern: SHA_PATTERN },
    branch: { type: 'string', maxLength: 200 },
    summary_md: { type: 'string', minLength: 1, maxLength: 20000 },
    deliverables: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'knowledge_md', 'tests', 'artifacts'],
      properties: {
        code: { type: 'array', maxItems: 500, items: { type: 'string', maxLength: 300 } },
        knowledge_md: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 300 } },
        tests: { type: 'array', maxItems: 500, items: { type: 'string', maxLength: 300 } },
        artifacts: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 300 } },
      },
    },
    validation: {
      type: 'object',
      additionalProperties: false,
      required: ['commands', 'environment'],
      properties: { commands: { type: 'array', minItems: 1, items: commandResult }, environment },
    },
    planning_proposal_id: { type: 'string', maxLength: 80 },
    ai_assisted: { type: 'boolean' },
    game_data_in_deliverables: { const: false },
    notes_md: { type: 'string', maxLength: 10000 },
  },
};

export const verificationSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://gta6-explorer.invalid/schemas/verification.schema.json',
  title: 'Independent verification of one commit',
  type: 'object',
  additionalProperties: false,
  required: ['commit_sha', 'verdict', 'checks', 'feedback_md', 'environment'],
  properties: {
    commit_sha: { type: 'string', pattern: SHA_PATTERN },
    verdict: { enum: ['approve', 'reject'] },
    checks: { type: 'array', minItems: 1, items: commandResult },
    feedback_md: { type: 'string', minLength: 1, maxLength: 20000 },
    environment,
    ai_assisted: { type: 'boolean' },
  },
};

export const usageReportSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://gta6-explorer.invalid/schemas/usage-report.schema.json',
  title: 'Self-reported model usage for one task (agent_report_usage)',
  type: 'object',
  additionalProperties: false,
  required: ['report_id', 'task_id', 'provider', 'model_id', 'measurement', 'method', 'source', 'confidence'],
  properties: {
    report_id: { type: 'string', minLength: 8, maxLength: 100 },
    task_id: { type: 'string', pattern: ID_PATTERN },
    provider: { type: 'string', minLength: 2, maxLength: 40 },
    model_id: { type: 'string', minLength: 2, maxLength: 120 },
    model_version: { type: 'string', maxLength: 80 },
    measurement: { enum: ['reported_actual', 'estimated', 'unknown'] },
    input_tokens: { type: 'integer', minimum: 0, maximum: 50000000 },
    output_tokens: { type: 'integer', minimum: 0, maximum: 50000000 },
    total_tokens: { type: 'integer', minimum: 0, maximum: 100000000 },
    method: { enum: ['runtime_usage_api', 'client_usage_report', 'tokenizer_count', 'heuristic', 'other', 'none'] },
    source: { type: 'string', minLength: 2, maxLength: 200 },
    confidence: { enum: ['high', 'medium', 'low', 'none'] },
    notes: { type: 'string', maxLength: 2000 },
  },
};

const opBase = (op, props, required) => ({
  type: 'object',
  additionalProperties: false,
  required: ['op', ...required],
  properties: { op: { const: op }, ...props },
});
const idRef = { type: 'string', pattern: `(${ID_PATTERN})|(^new:[a-z0-9-]+$)` };

export const planningProposalSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://gta6-explorer.invalid/schemas/planning-proposal.schema.json',
  title: 'Planning proposal (submitted as JSON in a PR to the coordinator repository)',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'id', 'rationale_md', 'based_on', 'operations'],
  properties: {
    schema_version: { const: 1 },
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{2,79}$' },
    rationale_md: { type: 'string', minLength: 1, maxLength: 20000 },
    based_on: {
      type: 'object',
      additionalProperties: false,
      required: ['roadmap_version', 'snapshot_at'],
      properties: { roadmap_version: { type: 'integer', minimum: 1 }, snapshot_at: { type: 'string', maxLength: 40 } },
    },
    operations: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        'x-discriminator': 'op',
        oneOf: [
          opBase('create_issue', {
            ref: { type: 'string', pattern: '^new:[a-z0-9-]+$' },
            repo: { type: 'string', pattern: REPO_PATTERN },
            replaces_draft: { type: 'string', pattern: ID_PATTERN },
            title: { type: 'string', minLength: 3, maxLength: 200 },
            body_md: { type: 'string', minLength: 1, maxLength: 20000 },
            task: { type: 'object' },
          }, ['ref', 'repo', 'title', 'body_md', 'task']),
          opBase('close_issue', { id: idRef, reason: { type: 'string', minLength: 1, maxLength: 2000 } }, ['id', 'reason']),
          opBase('set_priority', { id: idRef, priority: { enum: ['p0', 'p1', 'p2', 'p3'] } }, ['id', 'priority']),
          opBase('set_readiness', { id: idRef, readiness: { enum: ['draft', 'ready', 'needs_info', 'blocked_external'] } }, ['id', 'readiness']),
          opBase('add_dependency', { id: idRef, depends_on: idRef }, ['id', 'depends_on']),
          opBase('remove_dependency', { id: idRef, depends_on: idRef }, ['id', 'depends_on']),
          opBase('add_subissue', { parent: idRef, child: idRef }, ['parent', 'child']),
          opBase('roadmap_change', {
            milestone: { type: 'string', maxLength: 80 },
            change_md: { type: 'string', minLength: 1, maxLength: 10000 },
          }, ['milestone', 'change_md']),
          opBase('set_objective', { text_md: { type: 'string', minLength: 1, maxLength: 5000 } }, ['text_md']),
        ],
      },
    },
  },
};

export const ALL_SCHEMAS = {
  'task.schema.json': taskSchema,
  'profile.schema.json': profileSchema,
  'completion.schema.json': completionSchema,
  'verification.schema.json': verificationSchema,
  'planning-proposal.schema.json': planningProposalSchema,
  'usage-report.schema.json': usageReportSchema,
};
