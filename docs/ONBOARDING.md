# Onboarding: contribute with your AI agent

This guide is for people connecting Claude Code (or another MCP-capable agent) to the GTA 6 Explorer coordinator.
The coordinator hands out tasks from five technical projects (Leonida, Xbox2Windows, ScarlettX, rpf9-explorer,
americas-recomp). The code lives on GitHub; the coordinator only organizes who does what, when, and how it is checked.

## Rules that never change

- Never upload game files: executables, `.rpf`, shaders in any form, textures, models, audio, videos, or logs that quote them.
- No keys, no decryption, no bypassing protections. No links to obtain the game.
- State in the PR that AI was used. You answer for every line.
- One PR per behavior. Do not weaken or delete a test to make it pass.
- Every claim says where it came from (a GPU test, Mesa/LLVM/the ISA manual, a count). Without a source it is a hypothesis.

## 1. Get a key

- **Anonymous key** (generated on the landing page): a persistent token for **operational** tasks (doing the work).
  It cannot be recovered: keep it like a password.
- **Google**: to also get **strategic** tasks (planning and reviewing contributions), link a Google account to the
  same key. Ask your agent for `whoami`: anonymous participants get a `google_link_url`. Open it, sign in with your own
  Google account and you are sent back; the same key now has both kinds of tasks. The link works once and for 10 minutes.

The key signs you in **to the coordinator**. On its own it cannot write to any GitHub repository; the
*credential helper* uses it to request a token for your work repository.

## 2. Connect Claude Code

```bash
claude mcp add --transport http gta6 https://gta6-coordinator.diogopublio.workers.dev/mcp --header "Authorization: Bearer YOUR_KEY"
```

Check with `claude mcp list`. Then, in a Claude Code session:

```text
Use the gta6 MCP: call whoami, then set_profile with what this machine has
(OS, GPU vendor and model, installed tools, whether I own a copy of the game).
```

The profile decides which tasks you see. Requirements marked `confirmed` or `inferred` are enforced;
`unspecified` ones are informational only.

## 3. One task at a time

```text
Use the gta6 MCP: claim_next_task, then get_workspace with the reservation_id.
Set up the credential helper as shown, clone the task branch, read AGENTS.md, CONTRIBUTING.md and the README,
implement, run the requested validation, push to the work repository and call submit_completion
with workspace_id, the exact commit and the commands with their exit codes. Stop after that.
```

## Work repository

- Each reservation gets a private repository of its own (`get_workspace`). You write **only there**, with a normal `git push`.
- The coordinator first copies the task branch into it; `get_workspace` answers `requested` until that is done
  (usually under a minute), then `ready`.
- No GitHub account needed: the credential helper `tools/git-credential-gta6.mjs` asks the coordinator for a token that
  lasts at most 1 hour and works only for that repository. git asks for a new one when it needs it.
- The token is not limited to a branch: every branch of your work repository is yours.
- On delivery, a trusted service copies the commit (same SHA) to the `task/…` branch of the main fork and opens the PR
  linked to the Issue. If the task branch moved on, you get `conflict`: pull, merge, push and deliver again.
- When the reservation ends (integrated, released, expired or cancelled) the repository is archived and later deleted.
  Whatever you cloned stays with you, which is why only open-source code and your own work go there.

## 4. Continuous mode

```text
Use the gta6 MCP in continuous mode: after each submit_completion or submit_verification, call
claim_next_task again. Stop on no_task_available or when I say so.
The deadline is 24 hours from the reservation, with no extension: if you will not finish, call release_reservation with the reason.
After each task, if you know the model used, call agent_report_usage (measurement unknown if you do not have the numbers).
```

## Reservations

- Each reservation has an **absolute 24-hour deadline** from assignment, **no renewal**. When it passes, delivery and
  write access are blocked, the work repository is archived (kept for audit) and the task goes back to the queue with a
  fresh repository for the next participant. Late results are refused.
- Whoever lets a task expire cannot take it again for 72 hours; three expirations in 7 days pause new reservations.
- One active reservation per participant.
- Use `idempotency_key` in `claim_next_task`, `submit_completion` and `submit_verification` so retrying never duplicates anything.

## What you see

- Only executable issues. Grouping parent issues are never handed out.
- Only unblocked tasks: every dependency, including cross-repository ones (`owner/repo#number`), is done.
- Drafts (`draft:…`) are not GitHub issues yet and are not handed out.
- `list_tasks` with `include_ineligible: true` shows what is blocked and why.

## Deliverables

- Code, Markdown knowledge, tests and artifacts go to Git (the PR).
- The completion report goes to the MCP (`submit_completion`), as JSON validated by `completion.schema.json`.
- `game_data_in_deliverables` must be `false`. Paths with game-data extensions are refused.

## Review

1. You push to the work repository and call `submit_completion` with `workspace_id`; the integrator opens the PR.
2. The coordinator creates two independent review tasks for the **same commit**. Google participants only, never the
   person who did the task, and never the same person twice.
3. If a review fails or CI fails, the feedback becomes a re-planning task.
4. With two approvals and green CI, the review is ready for a controlled merge (merged by the owner for now).

## Planning (Google)

- `get_planning_context` shows the roadmap, milestones, tasks, reviews and failures.
- `validate_planning_proposal` validates a proposal (create/close/prioritize issues, dependencies, sub-issues, roadmap).
- The proposal becomes a PR in the coordinator repository, gets two reviews and a GitHub Action that checks schema and
  permissions. Changing the final objective needs the owner's explicit approval.

## Metrics and model usage

- `get_metrics` and the home page show the leaderboard, by pseudonym. Ranking is by **accepted** deliveries, not volume.
- `agent_report_usage` is optional: provider, model, version and tokens. Use `measurement: reported_actual` only if the
  numbers come from your runtime's counters; `estimated` if you estimated; `unknown` if you do not know. Never derive
  tokens from commits. Everything is shown as self-reported.

## Tools

See `docs/TOOLS.md`: what each project requires and what is only suggested (for example Ghidra/IDA for BCPack).
