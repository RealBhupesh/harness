import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { RunLock } from './lock.js';
import { CheckpointSchema, PlanSchema, type Config } from './schema.js';
import { MockProvider, type LLMProvider, type Request } from './provider.js';
import { BudgetProvider, BudgetExceeded } from './budget.js';
import { TraceStore, TracedProvider } from './trace.js';
import { revisePlanLocked } from './planner.js';
import { deadlineSignal } from './limits.js';
import { reconcileFailureUsage } from './usage.js';
import type { Memory } from './memory.js';
export async function generatePlan(
  memory: Memory,
  config: Config,
  provider: LLMProvider,
): Promise<void> {
  const release = new RunLock(memory.dir).acquire();
  let trace: TraceStore | undefined;
  try {
    const goal = readFileSync(join(memory.root, 'GOAL.md'), 'utf8');
    if (goal.includes('<<YOUR GOAL HERE') || !goal.trim())
      throw new Error('Replace the GOAL.md placeholder with a real objective.');
    const parallel = memory.read('parallel.json');
    const cp =
      (parallel
        ? CheckpointSchema.parse(
            (JSON.parse(parallel) as { checkpoint: unknown }).checkpoint,
          )
        : memory.checkpoint()) ??
      CheckpointSchema.parse({
        phase: 'SELECT',
        taskId: null,
        baseBranch: null,
        branch: null,
        baseSha: null,
        runId: randomUUID(),
        completed: 0,
        messages: [],
        steps: 0,
        taskStarted: 0,
        stopReason: null,
      });
    if (cp.taskId)
      throw new Error('Cannot replan during an active task; resume it first.');
    if (
      parallel &&
      (JSON.parse(parallel) as { entries: { stage: string }[] }).entries.some(
        (e) => !['done', 'failed'].includes(e.stage),
      )
    )
      throw new Error('Cannot replan with active parallel workers.');
    if (cp.snapshotPlan) memory.savePlan(cp.snapshotPlan);
    memory.savePlanningCheckpoint(cp);
    if (provider instanceof MockProvider) provider.position = cp.mockCursor;
    const messages = [
      {
        role: 'system' as const,
        content:
          'Return only valid plan JSON. Use small focused tasks, batch independent file work within each task, and include executable criteria covering all requirements. Preserve completed tasks exactly when revising.',
      },
      {
        role: 'user' as const,
        content: JSON.stringify({
          schema: PlanSchema.toJSONSchema(),
          goal,
          existing: memory.read('plan.json'),
        }),
      },
    ];
    const key = createHash('sha256')
      .update(JSON.stringify({ model: config.models.planner, messages }))
      .digest('hex');
    const remainingWall = config.maxWallTimeMs - cp.activeWallMs;
    if (remainingWall <= 0)
      throw new BudgetExceeded(
        'Cumulative planning wall-time cap reached; increase caps to resume.',
      );
    const request: Request = {
      role: 'planner',
      model: config.models.planner,
      messages,
      callId: `${cp.runId}/planning/${key}`,
      signal: deadlineSignal(Math.min(config.taskTimeoutMs, remainingWall)),
    };
    trace = new TraceStore(memory.dir);
    reconcileFailureUsage(cp, trace);
    const traced = new TracedProvider(provider, trace, () => ({
      runId: cp.runId,
      taskId: null,
    }));
    const charged = cp.chargedPlanningCalls.includes(request.callId!);
    const started = Date.now();
    let response: import('./provider.js').Response | undefined;
    try {
      response = charged
        ? traced.recover(request)
        : await new BudgetProvider(traced, config, cp.usage, (id) =>
            cp.chargedFailureEvents.push(id),
          ).complete(request);
      if (response && !charged) cp.chargedPlanningCalls.push(request.callId!);
    } finally {
      cp.activeWallMs += Date.now() - started;
      if (provider instanceof MockProvider) cp.mockCursor = provider.position;
      memory.savePlanningCheckpoint(cp);
    }
    if (!response)
      throw new Error(
        'Previously charged planner response is missing; inspect durable traces.',
      );
    if (response.toolCalls.length)
      throw new Error('Planner may not execute tools.');
    revisePlanLocked(
      memory,
      PlanSchema.parse(JSON.parse(response.content)),
      'Requested plan from current GOAL.md',
    );
  } finally {
    trace?.close();
    release();
  }
}
