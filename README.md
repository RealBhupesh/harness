# Relay

A resumable autonomous agent harness under construction. Read `docs/REQUIREMENTS.md` for the requested behavior and `.relay/STATE.md` for verified progress. Relay itself is developed here; it later pursues the objective in `GOAL.md`.

Requires Node >=20.19 (22 recommended) and pnpm 10.32.1. Run `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`.

## Offline demonstration

Run `pnpm build`, then `node examples/mock-demo.mjs /tmp/relay-demo-new`. Choose a destination that does not exist. The demo creates an isolated Git repository, runs `relay run` with scripted tool calls, executes a Node test independently, and merges a task commit.

In a target repository, run `relay init`, configure `.relay/config.json`, and provide `.relay/mock.json` (scripted provider responses) for offline runs. Plans use explicit executable acceptance criteria. File checks are appropriate for text artifacts; code should include command criteria that run tests. Live adapters support OpenAI and Anthropic native HTTPS APIs. Set `provider`, role `models`, and per-million input/output `prices` in `.relay/config.json`. Supply only `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` through the environment; never put keys in config or the repository. Set budget caps before running. Costs are estimates from configured rates, not a billing guarantee.

The command runner is a restricted policy boundary, not an operating-system sandbox. Repository tests and package scripts execute code. Use only trusted repositories inside an isolated development container.

`relay answer T1 "your answer"` records an answer and requeues a blocked task. Failed attempts remain in `.relay/worktrees/`. `relay resume` recovers saved phase, plan and tool progress after a process crash. Do not manually edit an active plan: use `relay plan` between tasks so completed tasks remain protected.

`relay status` reports progress and estimated usage. `relay trace T1` prints persisted task events. `relay report` regenerates `.relay/report.html`; every completed run also generates it. SQLite and JSONL traces and checkpoints are local runtime files; add the ignore rules shown in `.gitignore` to target repositories. Trace text and Markdown/checkpoints redact recognized keys and injected credential values. Redaction and the secret scan are defense in depth, not exhaustive secret detection.

## Parallel execution

Use `relay run --parallel 2 --max-tasks 5` for independent tasks. Each worker runs in its own worktree; verified branches merge one at a time, with the required suite and acceptance checks run again on the combined tree. Conflicts requeue the task; integration failures produce an explicit revert commit. The attempt cap includes failed attempts. Resume restores the saved width and reconciles worker spending before allocating more budget. Answers and replans require the runner to be stopped.

Try `node examples/mock-demo.mjs /tmp/relay-parallel-new --parallel` after building. It executes two independent tasks through the compiled CLI. Keep failed worktrees for inspection. If verification changes the main checkout, Relay pauses and preserves those changes for inspection instead of claiming success.
