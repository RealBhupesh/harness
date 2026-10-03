# Continuing Relay

Read in order: this file, `.relay/STATE.md`, `.relay/PLAN.md`, the last 50 lines of `.relay/LOG.md`, then `.relay/DECISIONS.md`. Never restart completed work; continue from **Next action** in STATE.md. The complete human requirements are in `docs/REQUIREMENTS.md`.

Install: `pnpm install --frozen-lockfile`. Build: `pnpm build`. Test: `pnpm test`. Typecheck: `pnpm typecheck`. Lint: `pnpm lint`. Format: `pnpm format`. CLI: `pnpm relay --help`.

Use Node >=20.19 (22 recommended), pnpm 10.32.1, strict TypeScript, Zod at untrusted boundaries, Vitest. No `any`, skipped assertions, or success stubs. Keep modules focused: `src/` implements schemas, providers, tools, Git, memory, orchestration and CLI; `tests/` uses isolated temporary repositories; `evals/` contains offline benchmark goals.

Write tests alongside implementation. A task is done only when tests, typecheck, lint and build pass and docs, PLAN.md and STATE.md describe the actual result. Small conventional commits reference task IDs. Do not commit credentials, runtime databases, or traces. Record decisions and concrete blockers. Update STATE.md with a precise next action and LOG.md with evidence before ending every session.

Cloud tasks already have isolated checkouts. Do not create a worktree for developing this repository unless explicitly requested. Relay's optional runtime worktrees are a separate, specified product feature.
