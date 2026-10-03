import { expect, test } from 'vitest';
import { readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PlanSchema, defaultConfig } from '../src/schema.js';
import { Memory } from '../src/memory.js';
import { MockProvider } from '../src/provider.js';
import { ToolRunner } from '../src/tools.js';
import { Orchestrator } from '../src/orchestrator.js';

import { fixture, plan, task } from './helpers.js';
test('rejects cyclic and unknown dependencies rather than hanging selection', () => {
  expect(
    PlanSchema.safeParse({
      ...plan,
      milestones: [
        { id: 'M1', title: 'Bad', tasks: [{ ...task, dependencies: ['T1'] }] },
      ],
    }).success,
  ).toBe(false);
  expect(
    PlanSchema.safeParse({
      ...plan,
      milestones: [
        {
          id: 'M1',
          title: 'Bad',
          tasks: [{ ...task, dependencies: ['missing'] }],
        },
      ],
    }).success,
  ).toBe(false);
});
test('tool policy prevents traversal, symlink escapes and shell injection', async () => {
  const root = fixture();
  const tools = new ToolRunner(root, defaultConfig());
  await expect(
    tools.run({ name: 'write', args: { path: '../escape', content: 'oops' } }),
  ).rejects.toThrow();
  symlinkSync(tmpdir(), join(root, 'outside'));
  await expect(
    tools.run({
      name: 'write',
      args: { path: 'outside/escape', content: 'oops' },
    }),
  ).rejects.toThrow();
  await expect(
    tools.run({ name: 'command', args: { argv: ['sh', '-c', 'echo unsafe'] } }),
  ).rejects.toThrow();
  await expect(
    tools.run({
      name: 'write',
      args: { path: '.git/config', content: 'oops' },
    }),
  ).rejects.toThrow();
  await expect(
    tools.run({ name: 'write', args: { path: '.env', content: 'secret' } }),
  ).rejects.toThrow();
});
test('mock loop verifies acceptance and produces a real task commit on main', async () => {
  const root = fixture();
  const memory = new Memory(root);
  memory.savePlan(PlanSchema.parse(plan));
  const provider = new MockProvider([
    {
      content: '',
      toolCalls: [
        {
          name: 'write',
          args: { path: 'hello.txt', content: 'Hello Relay\n' },
        },
      ],
    },
    { content: 'done', toolCalls: [] },
    {
      content: JSON.stringify({
        criteria: [
          { id: 'A1', passed: true, evidence: 'Greeting read and checked' },
        ],
        summary: 'Verified',
      }),
    },
  ]);
  const loop = new Orchestrator(root, defaultConfig(), provider);
  const result = await loop.run();
  expect(result.completed).toBe(1);
  expect(memory.loadPlan().milestones[0]?.tasks[0]?.status).toBe('done');
  expect(readFileSync(join(root, 'hello.txt'), 'utf8')).toBe('Hello Relay\n');
  expect(
    execFileSync('git', ['branch', '--show-current'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
  ).toBe('main');
  expect(
    execFileSync('git', ['log', '-1', '--format=%s'], {
      cwd: root,
      encoding: 'utf8',
    }),
  ).toContain('T1');
  expect(readFileSync(join(root, '.relay/STATE.md'), 'utf8')).toContain('100%');
});
