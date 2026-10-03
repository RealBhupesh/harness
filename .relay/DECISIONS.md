# Decisions

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
