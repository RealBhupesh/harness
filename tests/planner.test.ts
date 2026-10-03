import { expect, test } from 'vitest';
import { PlanSchema } from '../src/schema.js';
import { Memory } from '../src/memory.js';
import { revisePlan } from '../src/planner.js';
import { fixture, plan } from './helpers.js';
test('replanning preserves completed tasks and records the reason', () => {
  const memory = new Memory(fixture());
  const old = PlanSchema.parse(plan);
  old.milestones[0]!.tasks[0]!.status = 'done';
  memory.savePlan(old);
  expect(() =>
    revisePlan(memory, PlanSchema.parse(plan), 'new information'),
  ).toThrow('completed');
  const next = PlanSchema.parse(old);
  next.objective = 'Expanded objective';
  revisePlan(memory, next, 'New scope');
  expect(memory.loadPlan().milestones[0]?.tasks[0]?.status).toBe('done');
  expect(memory.read('DECISIONS.md')).toContain('New scope');
});
