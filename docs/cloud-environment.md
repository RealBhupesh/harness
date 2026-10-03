# Cloud development environment

Run `bash scripts/setup-cloud.sh` from this checkout. It installs the pinned lockfile, enables Corepack shims in writable `/workspace/.bin`, and checks lint, types, tests, build and offline evaluations. Corepack, npm, node-gyp and pnpm stores live under `/workspace/.cache` to avoid read-only home caches. Native SQLite builds need Python 3, make and a C++ compiler, all present in this environment.

In subsequent shell sessions, export:

```sh
export COREPACK_HOME=/workspace/.cache/corepack
export npm_config_cache=/workspace/.cache/npm
export npm_config_devdir=/workspace/.cache/node-gyp
export PATH="/workspace/.bin:$PATH"
cd /workspace/harness
```

Read `AGENTS.md`, `.relay/STATE.md`, `.relay/PLAN.md`, the tail of `.relay/LOG.md`, then `.relay/DECISIONS.md`. Continue from STATE's next action. No server, database service or credentials are needed for development: SQLite is embedded and tests/evaluations use mocks. Do not start Relay on the placeholder goal or replace this repository's development handoff with runtime state.

Live providers need optional credentials and outbound access to `api.openai.com` or `api.anthropic.com`; the existing cloud network policy permits package and Git hosts and has not been broadened for optional live use. Development setup does not request provider secrets. Cloud configuration draft saving is separate from publishing the environment.
