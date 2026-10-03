# Scheduled execution

`.github/workflows/relay.yml` supports manual dispatch and a six-hour schedule. Its job remains skipped unless repository variable `RELAY_ENABLED` is exactly `true`. Keep it disabled while `GOAL.md` is the placeholder.

Before enabling it, replace the goal, generate and review `.relay/plan.json`, and commit the plan and required test/typecheck/lint commands. Configure repository variable `RELAY_CONFIG` as the full non-secret Relay configuration: real provider, role models, current per-million rates, verification commands, and token/cost/time budgets. Add the selected provider's `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` as a GitHub Actions secret. Enable workflow permission to create pull requests. The runner uses Node 22 and pinned pnpm; it never automatically plans or enables itself.

Each run continues the persistent `relay/automation` branch, merges current main without force, resumes at most five task attempts in serial mode, and commits the human-readable plan and journal. It pushes the branch without force and opens a PR if none exists. Existing open PRs receive the branch's new commits. The workflow does not merge PRs. Branch conflicts stop execution for review. The plan must describe work appropriate for this repository.

Completed task boundaries persist through the automation branch. Checkpoints and worktrees remain local runtime state. If a run stops inside a task, the workflow stops before publishing progress and preserves Markdown, checkpoint, traces, a Git bundle and a worktree archive as a seven-day inspection artifact. Automatic restoration of interrupted worktrees on a new Actions runner is not implemented; inspect that artifact and resolve the paused task before restarting. Local/cloud snapshot crash resume is covered by subprocess tests. The Actions workflow itself has been statically checked, but has not been enabled or run with live credentials.

Use trusted repositories and scripts in an isolated runner. Relay's allowlist is a command policy, not an OS sandbox. Provider prices produce estimates; enforce provider-side billing limits as appropriate for the account.
