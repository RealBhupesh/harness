import { RunLock } from './lock.js';
import { allTasks } from './schema.js';
import type { Memory } from './memory.js';
export function answer(memory: Memory, taskId: string, text: string) {
  const release = new RunLock(memory.dir).acquire();
  try {
    if (!text.trim()) throw new Error('A nonempty answer is required');
    const plan = memory.committedPlan(),
      task = allTasks(plan).find((t) => t.id === taskId);
    if (!task || task.status !== 'blocked')
      throw new Error('Answer must reference a blocked task');
    task.notes.push(`Human answer: ${text.trim()}`);
    task.status = 'todo';
    task.attempts = 0;
    memory.append('DECISIONS.md', `Human unblocked ${taskId}: ${text.trim()}`);
    memory.append('QUESTIONS.md', `ANSWERED ${taskId}: ${text.trim()}`);
    memory.publishPlan(plan);
  } finally {
    release();
  }
}
