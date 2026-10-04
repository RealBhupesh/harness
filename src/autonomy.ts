import { z } from 'zod';
import { allTasks, type Config } from './schema.js';
import type { Memory } from './memory.js';
type Result = { completed: number; reason: string };
export async function runAutomatically(
  memory: Memory,
  config: Config,
  runBatch: (max: number) => Promise<Result>,
  maxAttempts = config.maxTasks,
  batchSize = 5,
): Promise<Result> {
  z.number().int().positive().parse(maxAttempts);
  z.number().int().positive().parse(batchSize);
  const limit = Math.min(maxAttempts, config.maxTasks);
  let spent = 0,
    completed = 0,
    reason =
      'Automatic task attempt limit reached; run relay auto to continue.';
  while (spent < limit) {
    const before = allTasks(memory.committedPlan()),
      cp = memory.checkpoint();
    const resumed = new Set(
      before.filter((t) => t.status === 'in_progress').map((t) => t.id),
    );
    if (cp?.taskId) resumed.add(cp.taskId);
    if (before.every((t) => t.status === 'done') && !resumed.size)
      return { completed, reason: 'All tasks complete.' };
    if (
      cp &&
      (cp.usage.tokens >= config.maxTokens ||
        cp.usage.cost >= config.maxCost ||
        cp.activeWallMs >= config.maxWallTimeMs)
    )
      return {
        completed,
        reason:
          'Cumulative token, cost or wall-time cap reached; increase caps to resume.',
      };
    const attempts = before.reduce((n, t) => n + t.attempts, 0);
    const result = await runBatch(Math.min(batchSize, limit - spent));
    completed += result.completed;
    reason = result.reason;
    const after = allTasks(memory.committedPlan()),
      newAttempts = after.reduce((n, t) => n + t.attempts, 0) - attempts;
    spent += Math.max(newAttempts + resumed.size, result.completed);
    if (after.every((t) => t.status === 'done') && !memory.checkpoint()?.taskId)
      return { completed, reason: 'All tasks complete.' };
    // An active task/worker represents a safe pause, not another batch to retry.
    if (
      after.some((t) => t.status === 'in_progress') ||
      memory.checkpoint()?.taskId
    )
      return { completed, reason };
    const runnable = after.some(
      (t) =>
        t.status === 'todo' &&
        t.dependencies.every(
          (id) => after.find((d) => d.id === id)?.status === 'done',
        ),
    );
    if (!runnable || (!newAttempts && !result.completed))
      return { completed, reason };
  }
  return {
    completed,
    reason: reason.includes('complete')
      ? reason
      : 'Automatic task attempt limit reached; run relay auto to continue.',
  };
}
