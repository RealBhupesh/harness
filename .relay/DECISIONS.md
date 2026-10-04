# Decisions

## Subscription efficiency (E2)
Use the human's existing subscriptions through official CLI authentication, not a separate $20 API budget. Require ChatGPT or Claude OAuth login per call and strip API/third-party billing environment configuration; pause rather than silently switch billing. CLI subscription cost is zero recorded incremental API spend, excluding monthly fees; reported API-equivalent cost is separate. Native completion limits are prompt targets, and valid native usage is charged even for malformed or failed decisions. Unknown provider consumption cannot be reconstructed.

Use bounded automatic batches with one cumulative token/cost/time ledger for planning and workers. Count failed and resumed attempts, including parallel workers. Include planner responses and wall time in durable accounting; terminal parallel journals remain checkpoint authority, so planner usage updates that journal before the root checkpoint. Persist failed-call usage receipts before charging and reconcile uncharged receipts once after a crash. Never convert an invalid decision to a tool proposal. Native watchdogs survive parent death; quota/auth/protocol pauses retain work without retry storms.

Preserve every executable check. Save tokens with bounded context, identical observation removal only when it reduces bytes, targeted patches and related operation batches; do not cache mutable command-test successes. Default economy concurrency is one, with explicit bounded parallelism. Apply low worker effort to Codex; defer Claude effort configuration and retain its native default. Live performance/quality claims require actual measurements on compatible CLI homes. Do not copy OAuth credentials or bypass this cloud environment's read-only home to force inference.

## Token efficiency (E1)
Use deterministic, bounded prompt projections rather than an extra paid summarizer call. Preserve task specifications and acceptance criteria, retain the latest failed command and recent exchanges, and allow small paged file reads. Keep full transcripts and executable evidence for durable recovery; excerpts carry byte counts and hashes. Pause before model calls when essential worker context cannot fit. Role output caps and budget reservations reflect the tools actually sent by each role.

Pin response replay to the canonical durable dialogue and model, independent of the transmitted summary. Use the existing fingerprint encoding so pre-compaction worker ledgers remain recoverable. Recover and charge an already-paid response before reserving a new call; exhausted budgets still stop subsequent requests. Report message-byte reductions separately from provider token usage and configured-price cost estimates. Synthetic mock savings do not establish live model quality or billing reductions.

## Initial architecture
Use the specified TypeScript/pnpm stack and a serial state machine first; alternatives were a heavy framework or immediate parallel execution. Explicit phases and serial verification are easier to inspect and recover. The GOAL.md placeholder is not a real objective; refuse planning until replaced. Cloud cache paths are local setup only.

## Attempt isolation
Use serial task worktrees early to preserve rejected changes without stashing or deleting user files. Failed worktrees remain under .relay/worktrees for inspection. Parallel scheduling remains M6.

## Crash recovery
Publish a checkpoint containing the plan snapshot before updating derived plan/Markdown; replay its transaction on restart. Persist a model response before tools, and cursor after each tool. File writes replay idempotently; patch detects already-applied content. Restricted test commands may be repeated after a crash: exactly-once arbitrary shell side effects are not promised. Git commit/merge are reconciled against task branch ancestry.

## Provider budgets
Use native HTTPS protocols rather than SDKs. Role models and per-million token rates are configurable; default rates are conservative examples and must match the selected model before live use. Reserve requests conservatively with UTF-8 input bytes and cap output. Meter observed usage durably. Estimated costs are not a guarantee about remote billing, cached-token discounts, reasoning tokens or network failures charged by the provider. Preserve charged worker responses across budget stops.

## Parallel coordination
Use bounded batches of dependency-ready tasks rather than a continuously refilled worker queue. Worker attempt worktrees remain isolated; integration is serial and checks the combined tree. Journal plan and usage before publishing derived memory. Preserve failed branches; explicit revert commits repair regressions. Pin each independently verified worker SHA/tree, merge that SHA, and check the final checkout remains the pinned integration artifact. Reconcile child checkpoints and model-response ledgers before granting resumed budgets. Local rollback cleanup must finish even when budgets are exhausted. Answers and replans acquire the coordinator lock rather than racing a running plan.

## Evaluation and scheduled execution
Use deterministic mock fixtures for pipeline regression and separate immutable scoring oracles for behavior; report mock scores as simulated rather than model capability. Optional live evaluations use explicit configuration and per-fixture caps. Scheduled execution is disabled by default, runs serially on a persistent automation branch, uses non-forced pushes and opens a review PR. Completed task boundaries persist through that branch. Interrupted runner worktrees are exported for manual inspection, not silently reconstructed from an incomplete plan on a fresh runner. Automatic cross-runner recovery remains a documented limitation.
