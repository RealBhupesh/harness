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
  const cp = memory.checkpoint();
  if (cp?.taskId)
    throw new Error('Cannot replan during an active task; resume it first');
  memory.savePlan(next);
  if (cp) memory.saveCheckpoint({ ...cp, phase: 'SELECT', stopReason: null });
  memory.append('DECISIONS.md', `Replanned: ${reason}`);
}
