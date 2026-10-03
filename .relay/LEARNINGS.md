# Learnings

Cloud machine caches must be under /workspace; do not disable TLS or artifact verification.

Use bash scripts/setup-cloud.sh for the complete development validation sequence. Export COREPACK_HOME=/workspace/.cache/corepack, npm_config_cache=/workspace/.cache/npm, npm_config_devdir=/workspace/.cache/node-gyp and PATH=/workspace/.bin:$PATH in later shells. Embedded SQLite needs no service. Entire-directory .relay ignores require literal changed-file Git staging; exclusion pathspecs against an ignored directory can fail.
