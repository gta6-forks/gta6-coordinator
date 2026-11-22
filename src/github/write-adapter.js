// GitHub WRITE side for MAIN forks / upstream (merge, planning apply, direct access requests).
// Decided 2026-11-21 (docs/SPEC.md §D-GIT): participants NEVER get write access to main forks or upstream;
// they write only to their isolated work repository (src/github/provisioner.js). Merge and planning apply are
// done by the backend GitHub App, which is not wired yet, so those calls return "pending_decision".
// This adapter never returns credentials and ignores any GitHub token present in the environment.

export const PENDING = 'pending_decision';

const NEXT_STEP = 'Participants never write to main forks. Use get_workspace for your isolated work repository; the trusted integration job opens the PR.';

function pending(action, extra = {}) {
  return { status: PENDING, action, credentials_issued: false, next_step: NEXT_STEP, ...extra };
}

function denied(action, reason, extra = {}) {
  return { status: 'denied', action, reason, credentials_issued: false, ...extra };
}

export class PendingGitWriteAdapter {
  constructor() {
    this.name = 'pending';
  }

  describe() {
    return {
      adapter: this.name,
      decided: false,
      writes_enabled: false,
      anonymous_write: 'own_work_repository_only',
      main_repository_write: 'forbidden_for_participants',
      work_repositories: 'see provisioner',
      pending: ['github_app_merge_executor', 'github_app_planning_apply'],
    };
  }

  async requestWriteAccess({ participant, task, kind }) {
    if (!participant || participant.kind === 'anonymous') return denied(`write_access:${kind}`, 'anonymous_write_forbidden');
    return denied(`write_access:${kind}`, 'main_repository_write_forbidden', { task_id: task?.id ?? null, next_step: NEXT_STEP });
  }

  async createIssueBranch({ participant, task }) {
    if (!participant || participant.kind === 'anonymous') return denied('create_issue_branch', 'anonymous_write_forbidden');
    return pending('create_issue_branch', { task_id: task?.id ?? null });
  }

  async requestMerge({ review }) {
    return pending('merge', { review_id: review.id, pr_url: review.pr_url, commit_sha: review.commit_sha });
  }

  async applyPlanning({ proposal }) {
    return pending('apply_planning', { proposal_id: proposal.id, operations: proposal.operations.length });
  }
}
