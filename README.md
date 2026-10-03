# Relay

A resumable autonomous agent harness under construction. Read `docs/REQUIREMENTS.md` for the requested behavior and `.relay/STATE.md` for verified progress. Relay itself is developed here; it later pursues the objective in `GOAL.md`.

Requires Node >=20.19 (22 recommended) and pnpm 10.32.1. Run `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`.

## Offline demonstration

Run `pnpm build`, then `node examples/mock-demo.mjs /tmp/relay-demo-new`. Choose a destination that does not exist. The demo creates an isolated Git repository, runs `relay run` with scripted tool calls, executes a Node test independently, and merges a task commit.

In a target repository, run `relay init`, configure `.relay/config.json`, and provide `.relay/mock.json` (scripted provider responses) for offline runs. Plans use explicit executable acceptance criteria. File checks are appropriate for text artifacts; code should include command criteria that run tests. Live model adapters are a later milestone.

The command runner is a restricted policy boundary, not an operating-system sandbox. Repository tests and package scripts execute code. Use only trusted repositories inside an isolated development container.
