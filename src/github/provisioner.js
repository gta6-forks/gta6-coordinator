// Isolated work repositories (owner decision 2026-11-21, docs/SPEC.md §D-GIT, docs/GITHUB_ISOLATION.md).
//
// One private work repository per reservation. The participant gets a token that can write ONLY to that
// repository (contents: write), at most 1 hour old, re-minted on demand while the reservation is active.
// Every backend token with a write permission is also restricted to one repository (see app-client.js).
// The participant starts from the public task branch of the main fork (read-only, no credentials needed)
// and pushes to the work repository with native git.
//
// Interface (all async):
//   describe()                       -> { name, enabled, ... } (no secrets)
//   provision({ workspace, task })   -> { status, repo_full_name, integration_repo, task_branch, base_sha }
//   mintCredential({ workspace })    -> { username, password, expires_at }   (ONLY secret-bearing call)
//   revoke({ workspace, reason })    -> { status }  archive: read-only for everyone, immediately
//   integrate({ workspace, head_sha })-> { status } dispatch the trusted integration workflow
//   cleanup({ workspace })           -> { status }  delete the work repository
import { AppError } from '../util.js';
import { GitHubAppClient } from './app-client.js';
import { getMeta, setMeta } from '../store/store.js';

export class DisabledProvisioner {
  constructor() {
    this.name = 'disabled';
  }
  describe() {
    return { name: this.name, enabled: false, reason: 'set WORKSPACE_PROVISIONER=github-app and the GitHub App secrets (docs/DEPLOY.md §7)' };
  }
  async provision() {
    return { status: 'provisioning_disabled' };
  }
  async mintCredential() {
    throw new AppError('provisioning_disabled', 'work-repository credentials are not available on this deployment', 503);
  }
  async revoke() {
    return { status: 'noop' };
  }
  async integrate() {
    return { status: 'provisioning_disabled' };
  }
  async cleanup() {
    return { status: 'noop' };
  }
}

const repoName = (workspace) => `w-${workspace.id.slice(3)}`;
const split = (full) => {
  const [owner, name] = String(full).split('/');
  return { owner, name };
};

export class GitHubAppProvisioner {
  constructor(env, { fetchImpl = (...args) => fetch(...args), now = () => Date.now(), sleep, store = null } = {}) {
    for (const k of ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_WORK_INSTALLATION_ID', 'GITHUB_APP_FORKS_INSTALLATION_ID', 'WORKSPACE_ORG', 'WORKSPACE_ANCHOR_REPO', 'COORDINATOR_REPO']) {
      if (!env[k]) throw new AppError('github_app_not_configured', `${k} missing`, 503);
    }
    this.name = 'github-app';
    this.env = env;
    this.now = now;
    this.store = store;
    this.gh = new GitHubAppClient({ appId: env.GITHUB_APP_ID, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY, fetchImpl, now, sleep });
    this.sleep = this.gh.sleep;
    this.org = env.WORKSPACE_ORG;
    this.workInst = env.GITHUB_APP_WORK_INSTALLATION_ID;
    this.forksInst = env.GITHUB_APP_FORKS_INSTALLATION_ID;
    this.coordInst = env.GITHUB_APP_COORDINATOR_INSTALLATION_ID || env.GITHUB_APP_FORKS_INSTALLATION_ID;
    this.createPerms = env.GITHUB_REPO_CREATE_PERMISSIONS ? JSON.parse(env.GITHUB_REPO_CREATE_PERMISSIONS) : undefined;
  }

  describe() {
    return { name: this.name, enabled: true, work_org: this.org, token_scope: 'one repository per write token' };
  }

  async #adminToken(name) {
    return (await this.gh.installationToken(this.workInst, { repositories: [name], permissions: { administration: 'write' } })).token;
  }

  async #spaceCreations() {
    // Secondary limits: <= 80 content-creating requests/min, <= 500/h. Keep >= 1s between repo creations.
    if (!this.store) return;
    const last = getMeta(this.store, 'github_last_repo_create_at', 0);
    const wait = last + 1000 - this.now();
    if (wait > 0) await this.sleep(wait);
    setMeta(this.store, 'github_last_repo_create_at', this.now());
  }

  async provision({ workspace, task }) {
    if (!task.fork_repo) return { status: 'integration_repo_missing' };
    const name = repoName(workspace);
    const full = `${this.org}/${name}`;
    // 1) create the private work repository (creation token: write only on the empty anchor repo).
    const creator = await this.gh.installationToken(this.workInst, { repositories: [this.env.WORKSPACE_ANCHOR_REPO], permissions: this.createPerms });
    await this.#spaceCreations();
    try {
      await this.gh.request('POST', `/orgs/${this.org}/repos`, {
        token: creator.token,
        body: {
          name,
          private: true,
          description: `GTA6 Explorer work repository for ${task.id} (${workspace.id})`,
          has_issues: false,
          has_projects: false,
          has_wiki: false,
          auto_init: false,
        },
        ok: [201],
      });
    } catch (err) {
      if (err.githubStatus !== 422) throw err; // 422 = already exists: idempotent retry of the same workspace
      const { data } = await this.gh.request('GET', `/repos/${full}`, { token: creator.token });
      if (!String(data.description ?? '').includes(workspace.id)) throw new AppError('repo_name_conflict', `${full} exists and is not this workspace`, 409);
    }
    // 2) no Actions in work repositories.
    const admin = await this.#adminToken(name);
    await this.gh.request('PUT', `/repos/${full}/actions/permissions`, { token: admin, body: { enabled: false }, ok: [204] });
    // 3) make sure the task branch exists in the main fork (token: contents write on the fork only).
    const { name: forkName } = split(task.fork_repo);
    const forkTok = (await this.gh.installationToken(this.forksInst, { repositories: [forkName], permissions: { contents: 'write' } })).token;
    let baseSha;
    try {
      const { data } = await this.gh.request('GET', `/repos/${task.fork_repo}/git/ref/heads/${workspace.task_branch}`, { token: forkTok });
      baseSha = data.object.sha;
    } catch (err) {
      if (err.githubStatus !== 404) throw err;
      const repo = (await this.gh.request('GET', `/repos/${task.fork_repo}`, { token: forkTok })).data;
      const main = (await this.gh.request('GET', `/repos/${task.fork_repo}/git/ref/heads/${repo.default_branch}`, { token: forkTok })).data;
      baseSha = main.object.sha;
      await this.gh.request('POST', `/repos/${task.fork_repo}/git/refs`, {
        token: forkTok,
        body: { ref: `refs/heads/${workspace.task_branch}`, sha: baseSha },
        ok: [201, 422],
      });
    }
    // 4) seed the work repository with the task branch (trusted Action; the participant token has no Workflows
    //    permission, so participants can never push the fork history themselves when it contains .github/workflows).
    await this.#dispatch('seed-workspace', {
      workspace_id: workspace.id,
      workspace_repo: full,
      integration_repo: task.fork_repo,
      task_branch: workspace.task_branch,
      base_sha: baseSha,
    });
    return { status: 'seeding', repo_full_name: full, integration_repo: task.fork_repo, task_branch: workspace.task_branch, base_sha: baseSha };
  }

  async mintCredential({ workspace }) {
    const { name } = split(workspace.repo_full_name);
    const t = await this.gh.installationToken(this.workInst, { repositories: [name], permissions: { contents: 'write' } });
    return { username: 'x-access-token', password: t.token, expires_at: t.expires_at, repositories: [workspace.repo_full_name] };
  }

  async revoke({ workspace }) {
    if (!workspace.repo_full_name) return { status: 'noop' };
    const { name } = split(workspace.repo_full_name);
    try {
      await this.gh.request('PATCH', `/repos/${workspace.repo_full_name}`, { token: await this.#adminToken(name), body: { archived: true } });
      return { status: 'archived' };
    } catch (err) {
      if (err.githubStatus === 404) return { status: 'already_gone' };
      throw err;
    }
  }

  async #dispatch(eventType, clientPayload) {
    const { name: coordName } = split(this.env.COORDINATOR_REPO);
    const t = (await this.gh.installationToken(this.coordInst, { repositories: [coordName], permissions: { contents: 'write' } })).token;
    await this.gh.request('POST', `/repos/${this.env.COORDINATOR_REPO}/dispatches`, {
      token: t,
      body: { event_type: eventType, client_payload: clientPayload },
      ok: [204],
    });
  }

  async integrate({ workspace, head_sha }) {
    const { name: coordName } = split(this.env.COORDINATOR_REPO);
    const t = (await this.gh.installationToken(this.coordInst, { repositories: [coordName], permissions: { contents: 'write' } })).token;
    await this.gh.request('POST', `/repos/${this.env.COORDINATOR_REPO}/dispatches`, {
      token: t,
      body: {
        event_type: 'integrate-workspace',
        client_payload: {
          workspace_id: workspace.id,
          workspace_repo: workspace.repo_full_name,
          integration_repo: workspace.integration_repo,
          task_branch: workspace.task_branch,
          head_sha,
          issue: workspace.task_id,
        },
      },
      ok: [204],
    });
    return { status: 'dispatched' };
  }

  async cleanup({ workspace }) {
    if (!workspace.repo_full_name) return { status: 'noop' };
    const { name } = split(workspace.repo_full_name);
    try {
      await this.gh.request('DELETE', `/repos/${workspace.repo_full_name}`, { token: await this.#adminToken(name), ok: [204] });
      return { status: 'deleted' };
    } catch (err) {
      if (err.githubStatus === 404) return { status: 'already_gone' };
      throw err;
    }
  }
}

export function createProvisioner(env, opts = {}) {
  if (env.WORKSPACE_PROVISIONER === 'github-app') return new GitHubAppProvisioner(env, opts);
  return new DisabledProvisioner();
}
