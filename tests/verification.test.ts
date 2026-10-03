import { expect, test } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, plan } from './helpers.js';
import { PlanSchema, defaultConfig } from '../src/schema.js';
import { Memory } from '../src/memory.js';
import { MockProvider } from '../src/provider.js';
import { Orchestrator } from '../src/orchestrator.js';
import { answer } from '../src/questions.js';

test('worker prose cannot bypass acceptance; after three attempts block and continue independent task', async () => {
  const root = fixture(),
    memory = new Memory(root);
  const next = { ...plan.milestones[0]!.tasks[0]!, id: 'T2', priority: 0 };
  memory.savePlan(
    PlanSchema.parse({
      ...plan,
      milestones: [
        {
          ...plan.milestones[0]!,
          tasks: [plan.milestones[0]!.tasks[0]!, next],
        },
      ],
    }),
  );
  const provider = new MockProvider([
    { content: 'I finished it' },
    { content: 'I finished it again' },
    { content: 'All tests pass!' },
    {
      content: '',
      toolCalls: [
        { name: 'write', args: { path: 'hello.txt', content: 'Hello Relay' } },
      ],
    },
    { content: 'done' },
    {
      content: JSON.stringify({
        criteria: [{ id: 'A1', passed: true, evidence: 'Greeting present' }],
        summary: 'Checked',
      }),
    },
  ]);
  expect(
    (await new Orchestrator(root, defaultConfig(), provider).run()).completed,
  ).toBe(1);
  const tasks = memory.loadPlan().milestones[0]!.tasks;
  expect(tasks[0]?.status).toBe('blocked');
  expect(tasks[0]?.attempts).toBe(3);
  expect(tasks[1]?.status).toBe('done');
  expect(memory.read('QUESTIONS.md')).toContain('T1');
  answer(memory, 'T1', 'Create hello.txt with the required greeting.');
  expect(memory.loadPlan().milestones[0]?.tasks[0]?.status).toBe('todo');
  expect(memory.read('DECISIONS.md')).toContain('Create hello.txt');
});
test('separate verifier rejection prevents commit even when mechanical checks pass', async () => {
  const root = fixture(),
    memory = new Memory(root);
  memory.savePlan(PlanSchema.parse(plan));
  const provider = new MockProvider([
    {
      content: '',
      toolCalls: [
        { name: 'write', args: { path: 'hello.txt', content: 'Hello Relay' } },
      ],
    },
    { content: 'done' },
    {
      content: JSON.stringify({
        criteria: [
          {
            id: 'A1',
            passed: false,
            evidence: 'Artifact has additional defects',
          },
        ],
        summary: 'Rejected',
      }),
    },
  ]);
  await new Orchestrator(
    root,
    { ...defaultConfig(), maxAttempts: 1 },
    provider,
  ).run();
  expect(memory.loadPlan().milestones[0]?.tasks[0]?.status).toBe('blocked');
  expect(existsSync(join(root, 'hello.txt'))).toBe(false);
});
test('empty verifier evidence is rejected', async () => {
  const root = fixture(),
    memory = new Memory(root);
  memory.savePlan(PlanSchema.parse(plan));
  const provider = new MockProvider([
    {
      content: '',
      toolCalls: [
        { name: 'write', args: { path: 'hello.txt', content: 'Hello Relay' } },
      ],
    },
    { content: 'done' },
    {
      content: JSON.stringify({
        criteria: [{ id: 'A1', passed: true, evidence: '' }],
        summary: 'Okay',
      }),
    },
  ]);
  await new Orchestrator(
    root,
    { ...defaultConfig(), maxAttempts: 1 },
    provider,
  ).run();
  expect(memory.loadPlan().milestones[0]?.tasks[0]?.status).toBe('blocked');
});
