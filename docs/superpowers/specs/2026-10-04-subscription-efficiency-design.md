# Subscription efficiency and autonomous continuation

The human wants Relay to run quickly and autonomously using approximately $20 Claude and Codex subscriptions. Treat subscription access as the default assumption while the optional billing clarification is pending. Subscription quotas are account limits, not API credit or unlimited usage; do not silently fall back to paid APIs.

## Providers

Add `codex-cli` and `claude-cli` providers through official, installed CLIs and existing subscription authentication. Authenticate before the first model call: require ChatGPT login for Codex, and Claude subscription OAuth for Claude. Remove API-key and third-party billing variables from the CLI environment. Allow explicit routing by planner/worker/verifier, with a hybrid profile splitting work between the two subscriptions.

Run each decision in an isolated temporary directory with native tools disabled where supported, Codex read-only sandbox, no project customizations, no persistent CLI session, structured output and a process watchdog. Relay continues to execute every proposed tool through its existing journal/policy and independently verifies the result. Never pass bypass-permission flags. Codex configuration/rules are disabled; Claude uses safe mode, no tools, and empty strict MCP configuration. Require compatible CLI versions/options; incompatible commands pause with actionable messages.

The wire response contains content plus tool names and JSON argument strings; CLI-reported usage supplies metering, never model claims. Subscription costs are recorded as zero incremental API spend, with billing provenance and reported API-equivalent cost separate. Token caps remain enforced; CLI output limits are prompt targets because the CLIs do not expose a guaranteed completion-token ceiling. Missing usage is an error, not zero-token success. Quota, authentication, timeout and protocol failures pause the current task without retry storms or losing its work.

## Efficiency and autonomy

An opt-in economy profile uses small bounded prompts, targeted patches, batched independent tool proposals, low worker reasoning effort and a separate verifier. Keep acceptance criteria and full durable transcripts. Deduplicate only identical successful read/search/Git observations in transmitted context, preserving the latest version and original checkpoint history. Do not skip executable verification.

Add `relay auto`: plan from a real goal when no plan exists, then continue checkpointed batches until the supplied total attempt limit, completion, blocked work, provider pause, or existing cumulative token/cost/time cap. Never invent a goal or overwrite a plan; do not reset budgets between batches or replan blocked tasks indefinitely. Parallel execution remains explicit and bounded. Diagnostic commands show provider readiness and subscription-versus-API billing without displaying credentials.

## Validation and limits

Use actual fake CLI subprocesses to test native flags, stdin, schemas, usage, authentication, quota pauses, output bounds and watchdog cancellation. Exercise complete serial and hybrid routing, auto continuation, cumulative budgets, malformed data, changed read versions, and legacy crash recovery. Extend offline prompt-byte scorecards; retain independent scoring and the false-success guard. Run all tests, lint, types, format, build and compiled CLI smoke tests before pushing. Live subscription quality/speed/quota claims require measured authenticated calls; report what was actually tested.
