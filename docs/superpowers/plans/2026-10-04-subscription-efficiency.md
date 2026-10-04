# Subscription Efficiency Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement inline with TDD and one independent final review.

**Goal:** Run Relay efficiently through subscription-authenticated Codex/Claude CLIs and bounded autonomous continuation.
**Architecture:** Add stateless structured CLI adapters behind the existing provider interface, billing-aware role routing, an opt-in profile and automatic batch continuation. Preserve the current journals and independent verification.
**Tech Stack:** Strict TypeScript, Node >=20.19, pnpm 10.32.1, Zod, Vitest; no new runtime dependencies.
**Spec:** docs/superpowers/specs/2026-10-04-subscription-efficiency-design.md

## Global Constraints

- Existing checkout only; preserve completed work, acceptance checks and recovery guarantees.
- Subscription auth only for CLI providers; no silent API billing or permission bypass.
- Node >=20.19; strict TypeScript; pnpm 10.32.1; no new runtime dependencies.

## Review Focus

- Account auth configured for API billing must pause before a model call.
- A killed parent must not leave a CLI running beyond its watchdog deadline.
- Malformed or missing usage must not be counted as a free successful call.
- Provider pauses and cumulative caps must survive automatic batch boundaries.
- Repeated reads of changed source must preserve the new content in the prompt.

## Task 1: Subscription providers

Files: create src/cli-process.ts, src/cli-provider.ts, src/provider-factory.ts, tests/cli-providers.test.ts; modify src/provider.ts, src/schema.ts, src/budget.ts, src/trace.ts, src/cli.ts, evals/run.ts.
Interfaces: CLIProvider(kind, config) implements LLMProvider; createProvider(config, memory, taskId?) returns the configured provider; role billing is available to budget reservation and reporting.
- [ ] Write and observe failing subprocess tests for auth, structured decisions, token usage, quotas, cancellation and routing.
- [ ] Implement bounded watchdog process transport, native protocols and billing-aware routing.
- [ ] Verify focused tests and full suite; record evidence.

## Task 2: Economy profile and automatic continuation

Files: create src/profiles.ts, src/autonomy.ts, tests/autonomy.test.ts; modify src/cli.ts, src/orchestrator.ts and docs.
Interfaces: economyProfile(selection, existing?) returns validated Config; runAutomatically(memory, config, runBatch, maxAttempts) returns total completed and reason without resetting caps. CLI auto creates a missing plan only from the actual goal.
- [ ] Write and observe failing tests for complete multi-batch work, pause/no-progress stops, attempt caps, profiles and no-overwrite configuration.
- [ ] Implement the profile and serial/parallel automatic entry point; surface billing accurately.
- [ ] Verify focused tests and full suite; record evidence.

## Task 3: Duplicate context removal and measured delivery

Files: modify src/prompts.ts, tests/efficiency.test.ts, evals documentation, README.md, .relay handoff.
Interfaces: workerPrompt preserves its existing request metadata while omitting identical old successful observations only when enabled.
- [ ] Write and observe failing tests for duplicate observations, changed content, different paths and opt-out.
- [ ] Implement deduplication and efficient tool instructions; keep all executable verification.
- [ ] Measure enabled/disabled offline context; review the complete patch independently.
- [ ] Run full setup checks, format and compiled CLI smoke tests; update handoff, commit and push.
