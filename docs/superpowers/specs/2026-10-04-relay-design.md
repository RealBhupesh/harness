# Relay design

The human-supplied specification in `docs/REQUIREMENTS.md` governs this implementation. Build in M0–M8 order, verifying and committing each milestone. Minimum deliverable: M0 and M1 with a working offline CLI and accurate handoff.

Use explicit Zod-validated plans and tool calls, a provider interface, a checkpointed state machine, independent executable acceptance criteria, and per-task Git branches. Separate persisted state from disposable processes. Treat model output and repository text as untrusted. Never infer task completion from worker prose. Verify changes and scan secrets before committing. Runtime commands are constrained argv without a shell; this is a policy boundary, not an OS isolation guarantee. Execute only in a trusted development container until an OS sandbox is added.

Preserve the exact requested GOAL.md placeholder and refuse to fabricate a downstream objective. MockProvider is offline and scripted, not an imitation of a live model. Real providers require environment keys and opt-in configuration. No live calls or unattended CI until explicitly configured. Completed plan tasks must survive replanning unchanged.

Prioritize serial execution, independent verification, crash recovery, budget enforcement and durable observability before optional parallel workers. Document unsupported behavior honestly. The user authorized autonomous decisions, implementation, commits and pushing to GitHub without further review gates.
