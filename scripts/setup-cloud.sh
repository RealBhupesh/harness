#!/usr/bin/env bash
set -euo pipefail
export COREPACK_HOME=/workspace/.cache/corepack
export npm_config_cache=/workspace/.cache/npm
export npm_config_devdir=/workspace/.cache/node-gyp
mkdir -p /workspace/.bin
corepack enable --install-directory /workspace/.bin
export PATH="/workspace/.bin:$PATH"
relay_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$relay_root"
corepack pnpm install --frozen-lockfile --store-dir /workspace/.cache/pnpm-store
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm eval
