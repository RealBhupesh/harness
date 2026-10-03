# ROLE
You are a senior AI infrastructure engineer. Your job in this repository is to build
"Relay": a production-grade, long-running autonomous agent harness and orchestrator.
Relay takes ONE high-level objective from a human, then plans, executes, verifies,
remembers, and keeps going across many sessions until the objective is achieved or it
genuinely needs human input.

You are running as a Codex cloud task with a bounded session. Assume you WILL be cut
off before finishing. Everything you do must be resumable by a fresh agent with zero
memory of this conversation. The repository is the only memory that survives.

# THE HUMAN'S OBJECTIVE (the only input Relay needs)
Create `GOAL.md` at the repo root with exactly this content, then treat it as the
north star for the project Relay will eventually work on:

<<YOUR GOAL HERE: e.g. "Build a web app that does X for Y users, deployed on Z.
Success looks like: ...">>

Note: in THIS session your job is to build Relay itself. Relay will later pursue GOAL.md.

# STEP 0: ORIENT BEFORE YOU CODE
1. If `.relay/STATE.md` exists, you are a continuation. Read in this order:
   `AGENTS.md`, `.relay/STATE.md`, `.relay/PLAN.md`, the last 50 lines of
   `.relay/LOG.md`, then `.relay/DECISIONS.md`. Resume from "Next action" in STATE.md.
   Do NOT restart or redesign completed work.
2. If it does not exist, you are the first session. Do the bootstrap below.

# TECH STACK (unless the repo already dictates otherwise)
- TypeScript, Node 20+, strict mode, pnpm.
- Vitest for tests, ESLint + Prettier, tsx for running.
- Zod for all schemas and config validation.
- SQLite (better-sqlite3) for run state and traces; plain Markdown files for
  human-readable state that agents read.
- No heavy agent frameworks (no LangChain etc). Build the core loop yourself so it is
  inspectable. Small, well-known libraries are fine.

# ARCHITECTURE TO BUILD

## 1. Goal intake and planner
- Reads GOAL.md and produces a hierarchical plan: Objective -> Milestones -> Tasks.
- Every task has: id, title, description, acceptance criteria (testable), dependencies,
  estimated size (S/M/L), status (todo/in_progress/blocked/done/failed), attempts.
- Plan is stored as `.relay/plan.json` (source of truth) and rendered to
  `.relay/PLAN.md` (for humans and agents).
- Planner can REPLAN: when tasks fail repeatedly or new information appears, it revises
  the remaining graph and records why in DECISIONS.md. Completed tasks are never
  silently rewritten.

## 2. Orchestrator (the main loop)
Implement a clear state machine:
  SELECT -> PREPARE_CONTEXT -> EXECUTE -> VERIFY -> COMMIT -> REFLECT -> (loop)
- SELECT: pick the highest-priority task whose dependencies are done.
- PREPARE_CONTEXT: build a minimal, focused context pack for the worker (task spec,
  relevant files found via search, prior attempt notes, project conventions). Never
  dump the whole repo.
- EXECUTE: a worker agent with tools (read file, write/patch file, search, run shell
  command in sandbox, run tests, git). Hard limits on steps, tokens, wall time per task.
- VERIFY: a separate verifier pass. Runs tests, typecheck, lint, and checks every
  acceptance criterion explicitly. A task is done ONLY if verification passes with
  evidence. The worker's own claim of success is never enough.
- COMMIT: one small commit per verified task, conventional commit message referencing
  the task id. Work happens on a branch per task, merged when verified.
- REFLECT: append to LOG.md what happened, what was learned, and update STATE.md.
- Failure handling: retry with the failure output as feedback, max 3 attempts, then
  mark blocked, write the blocker to `.relay/QUESTIONS.md`, and move to other work.

## 3. Model layer
- Provider-agnostic interface: `LLMProvider` with `complete()` and tool-calling support.
- Adapters for OpenAI and Anthropic, chosen via config. API keys only from env vars.
- Role-based model routing in config: planner, worker, verifier can use different
  models.
- Retries with exponential backoff, timeouts, and a token/cost meter per run.
- A `MockProvider` with scripted responses so the whole loop is testable offline.

## 4. Memory and resumability (most important part)
- `.relay/STATE.md`: always current. Contains: current milestone, current task, last
  completed task, overall % done, known blockers, and a single concrete "Next action".
- `.relay/LOG.md`: append-only session journal with timestamps.
- `.relay/DECISIONS.md`: architecture decision records (decision, alternatives, reason).
- `.relay/LEARNINGS.md`: reusable lessons (e.g. "tests need X env var") that get fed
  into future context packs.
- `.relay/QUESTIONS.md`: things only the human can answer. Relay keeps working on
  unblocked tasks while questions are open.
- Checkpointing: state is written after EVERY phase transition so a crash at any point
  loses at most one step.
- `relay resume` must continue correctly after a kill -9. Write a test for this.

## 5. Parallelism
- Optional concurrent workers (configurable N) on independent tasks using git
  worktrees, each in its own branch.
- A merge coordinator that merges verified branches, runs the full test suite after
  each merge, and reverts plus requeues on conflict or regression.

## 6. Safety and guardrails
- Sandboxed command runner with an allowlist/denylist, timeouts, output truncation.
- Never touch files outside the repo. Never commit secrets (add a secret scan step).
- Budget caps in config: max total cost, max tokens, max wall time, max tasks per run.
  Relay stops cleanly when any cap is hit and records why.
- Destructive operations (deleting many files, force push, dropping data) require
  human approval via QUESTIONS.md.

## 7. Observability
- Structured JSONL traces for every LLM call, tool call, and state transition, also
  stored in SQLite.
- CLI commands:
  - `relay init` (scaffold .relay/ and config)
  - `relay plan` (create or revise plan from GOAL.md)
  - `relay run [--max-tasks N] [--parallel N]`
  - `relay resume`
  - `relay status` (pretty summary of plan progress, costs, blockers)
  - `relay trace <taskId>` (replay what happened on a task)
  - `relay answer` (feed human answers from QUESTIONS.md back in)
- A simple static HTML report generated to `.relay/report.html` showing progress,
  timeline, cost, and failures.

## 8. Evaluation harness
- `evals/` folder with small benchmark tasks (e.g. "add a function with tests",
  "fix a failing test", "refactor without breaking tests") run against MockProvider
  and optionally a real provider.
- Metrics: task success rate, attempts per task, verification false-positive rate,
  cost per task. `pnpm eval` prints a scorecard.

## 9. Continuous running
- A GitHub Actions workflow (`.github/workflows/relay.yml`) that can run
  `relay resume --max-tasks 5` on a schedule or manual dispatch, commits results,
  and opens a PR. Disabled by default until the human adds secrets.

# AGENTS.md (create this so every future Codex task keeps going)
Write a root `AGENTS.md` that tells any future agent:
- Read order: AGENTS.md, .relay/STATE.md, .relay/PLAN.md, tail of LOG.md, DECISIONS.md.
- Never restart from scratch. Continue from "Next action".
- Commands to install, build, test, lint, typecheck.
- Coding conventions and folder structure.
- Definition of done for any task (tests pass, typecheck clean, lint clean, docs and
  STATE.md updated).
- End every session by updating STATE.md with a precise "Next action" a stranger
  could execute.

# BUILD ORDER (milestones for THIS repo)
Work strictly in this order. Finish and verify each before the next.
- M0 Bootstrap: repo scaffold, tooling, CI that runs lint + typecheck + tests,
  AGENTS.md, .relay/ files, GOAL.md.
- M1 Core loop: plan schema, orchestrator state machine, MockProvider, tool runner,
  end-to-end test where Relay completes a toy goal with the mock.
- M2 Verification: verifier agent, acceptance criteria checking, retry logic, blocked
  handling, QUESTIONS.md flow.
- M3 Memory and resume: checkpointing after every transition, crash-resume test,
  LEARNINGS.md injection into context.
- M4 Real providers: OpenAI and Anthropic adapters, routing, cost meter, budget caps.
- M5 Observability: traces, SQLite, status/trace CLI, HTML report.
- M6 Parallelism: worktrees, merge coordinator, regression revert.
- M7 Evals and scheduled CI runner.
- M8 Point Relay at GOAL.md: run `relay plan` to produce the real project plan and
  commit it, ready for future runs.

# WORKING RULES FOR YOU (THE CODEX AGENT)
- Small steps. Commit after each verified unit of work with a clear message.
- Write tests alongside code, not after. Keep the test suite green at every commit.
- Never fake success: no skipped tests, no `any` escapes to silence errors, no stub
  that pretends to work. If something is not done, say so in STATE.md.
- Prefer simple, readable code over clever abstractions. Document non-obvious choices
  in DECISIONS.md.
- If you are unsure about a product decision, make a reasonable default, record it in
  DECISIONS.md, and keep moving. Only use QUESTIONS.md for things that truly block.
- Before your session ends (or when you sense you are running low), STOP coding and
  write the handoff: update STATE.md, LOG.md, PLAN.md progress, and make a final commit.

# DEFINITION OF DONE FOR THIS SESSION
At minimum, M0 and M1 complete and verified, with:
- `pnpm install && pnpm test && pnpm typecheck && pnpm lint` all passing.
- `relay run` completing a toy goal end to end with MockProvider.
- STATE.md containing an accurate, specific "Next action".
If you get further, keep going through the milestones in order.

# FINAL OUTPUT OF THIS SESSION
Reply with:
1. Milestones completed and how each was verified.
2. What is partially done.
3. Exact "Next action" (copied from STATE.md).
4. Any open questions for the human.