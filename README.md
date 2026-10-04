# Relay

A resumable autonomous agent harness under construction. Read `docs/REQUIREMENTS.md` for the requested behavior and `.relay/STATE.md` for verified progress. Relay itself is developed here; it later pursues the objective in `GOAL.md`.

Requires Node >=20.19 (22 recommended) and pnpm 10.32.1. Run `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`.

## Offline demonstration

Run `pnpm build`, then `node examples/mock-demo.mjs /tmp/relay-demo-new`. Choose a destination that does not exist. The demo creates an isolated Git repository, runs `relay run` with scripted tool calls, executes a Node test independently, and merges a task commit.

In a target repository, run `relay init`, configure `.relay/config.json`, and provide `.relay/mock.json` (scripted provider responses) for offline runs. Plans use explicit executable acceptance criteria. File checks are appropriate for text artifacts; code should include command criteria that run tests. Live adapters support OpenAI and Anthropic native HTTPS APIs. Set `provider`, role `models`, and per-million input/output `prices` in `.relay/config.json`. Supply only `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` through the environment; never put keys in config or the repository. Set budget caps before running. Costs are estimates from configured rates, not a billing guarantee.

The command runner is a restricted policy boundary, not an operating-system sandbox. Repository tests and package scripts execute code. Use only trusted repositories inside an isolated development container.

`relay answer T1 "your answer"` records an answer and requeues a blocked task. Failed attempts remain in `.relay/worktrees/`. `relay resume` recovers saved phase, plan and tool progress after a process crash. Do not manually edit an active plan: use `relay plan` between tasks so completed tasks remain protected.

`relay status` reports progress and estimated usage. `relay trace T1` prints persisted task events. `relay report` regenerates `.relay/report.html`; every completed run also generates it. SQLite and JSONL traces and checkpoints are local runtime files; add the ignore rules shown in `.gitignore` to target repositories. Trace text and Markdown/checkpoints redact recognized keys and injected credential values. Redaction and the secret scan are defense in depth, not exhaustive secret detection.

## Existing Claude and Codex subscriptions

Use the official logged-in CLIs with `relay init --profile economy --provider hybrid`, then supply a real `GOAL.md` and run `relay auto --max-tasks 20`. The hybrid profile uses Claude Haiku for planning, Codex for work and Claude Sonnet for independent verification. Choose `codex-cli` or `claude-cli` instead to use one account. For an existing setup, use `relay profile economy --provider hybrid` before starting work.

Automatic mode continues bounded batches while preserving cumulative usage and checkpoints. It stops on completion, blocked work, quota pauses or task/token/time limits. Native adapters require subscription authentication, remove API-key environment variables and refuse API authentication. Quotas still apply; there is no silent paid API fallback. See [subscription setup and limits](docs/subscriptions.md).

## Parallel execution

Use `relay run --parallel 2 --max-tasks 5` for independent tasks. Each worker runs in its own worktree; verified branches merge one at a time, with the required suite and acceptance checks run again on the combined tree. Conflicts requeue the task; integration failures produce an explicit revert commit. The attempt cap includes failed attempts. Resume restores the saved width and reconciles worker spending before allocating more budget. Answers and replans require the runner to be stopped.

Try `node examples/mock-demo.mjs /tmp/relay-parallel-new --parallel` after building. It executes two independent tasks through the compiled CLI. Keep failed worktrees for inspection. If verification changes the main checkout, Relay pauses and preserves those changes for inspection instead of claiming success.

## Efficient context

Worker requests keep the task and acceptance criteria, compact repeated code and tool output, remove identical older successful read/search/Git observations, and omit older history when needed. The latest failed command and recent exchanges remain available. Full tool transcripts stay in checkpoints and traces; workers can reread files with one-based `startLine` and `maxLines` (default 100, maximum 1000). Paged reads respect the output byte cap and UTF-8 boundaries. Verification still executes every configured check and criterion; only the model-facing evidence is excerpted, with hashes and byte counts.

Configure these defaults in `.relay/config.json`:

```json
{
  "context": {
    "enabled": true,
    "maxPromptBytes": 48000,
    "maxEntryBytes": 4000,
    "maxEvidenceBytes": 1200
  },
  "roleOutputTokens": { "planner": 2048, "worker": 2048, "verifier": 1024 }
}
```

`maxPromptBytes` bounds serialized worker messages. Relay pauses before a model call if the essential task and retained context cannot fit; increase the limit or split the task. Set `context.enabled` to `false` to use the original context behavior. Role output limits also obey the global `maxOutputTokens` and remaining budget; raise the verifier limit for tasks with many criteria. Recorded worker responses replay against the full durable dialogue even if context settings change after a crash.

LLM trace events record original/sent message bytes and omissions. `pnpm eval` includes a synthetic long-context fixture to measure this reduction. Bytes and `estimatedMessageTokens` (bytes divided by four) are diagnostic proxies; provider-reported token usage and configured-price cost estimates are recorded separately. Tool definitions and provider envelope overhead are excluded from the prompt byte comparison. Live token savings have not been measured.

## Evaluations and automation

Run `pnpm eval` for isolated offline benchmarks and an oracle-backed scorecard. Optional real-provider runs require explicit configuration; see [evals/README.md](evals/README.md). The [scheduled workflow](docs/continuous-running.md) is disabled by default and opens a progress PR only when explicitly enabled. Interrupted Actions worktrees require manual recovery; local crash resume is tested.

[Cloud setup](docs/cloud-environment.md) describes writable caches, reusable installation, and continuation instructions. `GOAL.md` still needs your real objective before Relay can generate the downstream plan.
