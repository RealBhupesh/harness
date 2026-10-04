# Existing subscription setup

Relay can use the official Codex and Claude Code CLIs through your existing ChatGPT and Claude subscriptions. Install and log in to the selected CLI using its official subscription flow. Run Relay on that machine, with Node >=20.19, Git and a trusted target repository. Account/model availability and quotas remain controlled by the provider.

Build Relay with `pnpm build`. In the target repository, invoke the compiled CLI as `node /path/to/harness/dist/src/cli.js`; the examples below abbreviate that as `relay`.

```sh
relay init --profile economy --provider hybrid
# Replace GOAL.md with your actual objective and executable success criteria.
relay doctor
relay auto --max-tasks 20
relay status
```

`hybrid` uses Claude Haiku to plan, Codex's default model to work, and Claude Sonnet to verify. Choose `codex-cli` or `claude-cli` instead to use one subscription. Change model names in `.relay/config.json` if your account does not support a selected model. For an initialized repository, apply `relay profile economy --provider hybrid` before work starts; initialization never overwrites existing configuration. Profile changes require no active serial task or parallel journal.

The profile tightens prompt/evidence sizes and output targets, keeps existing spending limits, and uses low Codex worker reasoning effort. Claude currently retains its native reasoning-effort default. Workers receive instructions to batch related operations and use targeted patches. Repeated identical observations are removed from transmitted history when that reduces bytes; changed observations and complete durable transcripts remain available. Every configured executable check and independent verification still runs.

`auto` creates a missing plan from the real goal, then continues checkpointed batches. Its total attempt cap includes failed and resumed attempts. Planning and workers share cumulative usage/time limits; batches do not reset them. Quota, authentication, timeout, invalid output, exhausted budget and blocked dependencies stop continuation. After a quota reset, use `relay auto --max-tasks 20` again to resume. Adjust configured caps deliberately when needed. For independent tasks, `relay auto --parallel 2 --max-tasks 20` enables bounded concurrency; serial operation is the economy default.

## Billing and protocol limits

- Subscription adapters verify ChatGPT/Claude OAuth authentication on every call, remove API-key and third-party billing variables from the child environment, and refuse API authentication. API adapters remain available only through explicit provider configuration; no automatic fallback occurs.
- Native token usage is recorded, including valid usage reported alongside a failed/malformed decision. Failed-call receipts survive crashes and are charged once. If the CLI reports no valid usage, Relay pauses; unreported provider consumption cannot be reconstructed.
- Subscription `cost: 0` means zero incremental API spend recorded by Relay. It excludes your monthly subscription. Claude's reported API-equivalent cost is stored separately and does not represent your subscription bill.
- `roleOutputTokens` is a prompt target for native CLIs, whose interfaces do not guarantee a completion-token ceiling. A returned call can exceed its target or the remaining token cap; its reported usage is charged and subsequent requests stop. API adapters retain their protocol output caps.
- `doctor` checks installation and authentication only. It neither calls a model nor proves quota availability or successful inference. CLI command paths/arguments in configuration are trusted local executable configuration.
- A separate watchdog bounds native process time and output bytes even if Relay is killed. Native decisions run in temporary directories with project customizations/native tools disabled where supported, and Codex uses a read-only sandbox. Relay executes returned tool proposals through its own policies. Repository tests still execute code: use an isolated environment with trusted scripts.

## Validation in this cloud environment

Native options were inspected with Codex `0.159.0-alpha.3` and Claude Code `2.1.289`. Actual subprocess fixtures cover both protocols, subscription/API authentication, role routing, known failed-call usage, quota pauses, cancellation and parent-death watchdog behavior. Offline task tests exercise cumulative limits, failed/resumed attempts and crash recovery.

Codex reports an existing ChatGPT login here, but live inference fails while initializing its app server because its CLI home is read-only. Supported temporary SQLite/log overrides did not resolve that restriction. Claude live inference has not been tested. No credentials were copied and no paid API fallback was used. Live speed, model quality, subscription quota efficiency and token savings remain unmeasured; offline byte reductions are context diagnostics.
