# Decisions

## Initial architecture
Use the specified TypeScript/pnpm stack and a serial state machine first; alternatives were a heavy framework or immediate parallel execution. Explicit phases and serial verification are easier to inspect and recover. The GOAL.md placeholder is not a real objective; refuse planning until replaced. Cloud cache paths are local setup only.

## Attempt isolation
Use serial task worktrees early to preserve rejected changes without stashing or deleting user files. Failed worktrees remain under .relay/worktrees for inspection. Parallel scheduling remains M6.
