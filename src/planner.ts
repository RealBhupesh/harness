import { allTasks, PlanSchema, type Plan } from './schema.js';
import type { Memory } from './memory.js';
export function revisePlan(memory: Memory, proposal: Plan, reason: string) {
  if (!reason.trim()) throw new Error('Replanning requires a reason');
  const next = PlanSchema.parse(proposal);
  if (memory.read('plan.json'))
    for (const completed of allTasks(memory.loadPlan()).filter(
      (t) => t.status === 'done',
    )) {
      const replacement = allTasks(next).find((t) => t.id === completed.id);
      if (JSON.stringify(completed) !== JSON.stringify(replacement))
        throw new Error(`Cannot rewrite completed task ${completed.id}`);
    }
  const previous = memory.read('plan.json') ? allTasks(memory.loadPlan()) : [];
  for (const task of allTasks(next)) {
    const old = previous.find((t) => t.id === task.id);
    if (task.status === 'done' && old?.status !== 'done')
      throw new Error(`Cannot mark unverified task ${task.id} done`);
    if (task.status === 'in_progress')
      throw new Error('Planner cannot create in_progress tasks');
    if (old && old.status !== 'done') {
      task.attempts = old.attempts;
      task.notes = [...new Set([...old.notes, ...task.notes])];
    }
  }
  const cp = memory.checkpoint();
  if (cp?.taskId)
    throw new Error('Cannot replan during an active task; resume it first');
  if (cp)
    memory.saveCheckpoint({
      ...cp,
      phase: 'SELECT',
      stopReason: null,
      snapshotPlan: next,
    });
  memory.savePlan(next);
  memory.append('DECISIONS.md', `Replanned: ${reason}`);
}
