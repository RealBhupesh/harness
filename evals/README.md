# Relay evaluations

`pnpm eval` runs three isolated Git repositories: add a function while retaining an existing export, fix a failing addition test (the mock deliberately requires a second attempt), and refactor a sum implementation without changing behavior. Each uses actual tool writes, test commands, independent verification and Git integration. A scoring oracle outside the worker checkout checks additional cases after integration. A fourth negative guard claims success while leaving broken code and must be rejected.

The scorecard reports success rate, mean attempts per benchmark, false positives among approved tasks, and estimated mean cost per benchmark. No approvals produce `null` for the false-positive rate. The negative guard is reported separately and always uses MockProvider. A mock regression or approved negative guard makes the command fail. Fixtures are removed after scoring; failure notes are included in output.

The deterministic mock run validates orchestration, not general model capability. Its expected baseline is 3/3 successes, 1.33 attempts/task, 0 observed false positives, and $0 simulated cost. Three examples do not establish production reliability.

For optional live benchmarking, provide an API key through the environment and a non-secret JSON `RELAY_EVAL_CONFIG` containing `provider`, role `models`, correct per-million `prices`, and budget caps, then run `pnpm eval --live`. Config uses the same schema as `.relay/config.json`. Caps apply separately to each fixture; total possible spend is up to three fixture budgets. Real calls are opt-in, incur costs, and have not been tested in this environment. Live failures remain measurements rather than being replaced with mock success.
