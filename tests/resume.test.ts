import { expect, test } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Memory } from '../src/memory.js';
import { PlanSchema } from '../src/schema.js';
import { fixture, plan } from './helpers.js';
import { RunLock } from '../src/lock.js';
for (const phase of [
  'SELECT',
  'PREPARE_CONTEXT',
  'EXECUTE',
  'VERIFY',
  'COMMIT',
  'REFLECT',
  'merged',
  'tool',
]) {
  test(`actual SIGKILL at ${phase} resumes to exactly one task commit`, () => {
    const root = fixture(),
      memory = new Memory(root);
    memory.savePlan(PlanSchema.parse(plan));
    memory.write(
      'mock.json',
      JSON.stringify([
        {
          content: '',
          toolCalls: [
            {
              name: 'write',
              args: { path: 'hello.txt', content: 'Hello Relay' },
            },
          ],
        },
        { content: 'done' },
        {
          content: JSON.stringify({
            criteria: [{ id: 'A1', passed: true, evidence: 'Greeting exists' }],
            summary: 'Verified',
          }),
        },
      ]),
    );
    const args = [
      '--import',
      import.meta.resolve('tsx'),
      resolve('tests/crash-child.mjs'),
      root,
      phase,
    ];
    const killed = spawnSync(process.execPath, args, { encoding: 'utf8' });
    expect(killed.signal, killed.stderr).toBe('SIGKILL');
    const resumed = spawnSync(process.execPath, args, { encoding: 'utf8' });
    expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
    expect(memory.loadPlan().milestones[0]?.tasks[0]?.status).toBe('done');
    expect(
      execFileSync('git', ['rev-list', '--count', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
    ).toBe('2');
  });
}
test('an active run lock prevents a second orchestrator from modifying checkpoints', () => {
  const memory = new Memory(fixture());
  const first = new RunLock(memory.dir);
  const release = first.acquire();
  expect(() => new RunLock(memory.dir).acquire()).toThrow('already running');
  release();
  const unlock = new RunLock(memory.dir).acquire();
  unlock();
});
test('a budget stop preserves the worker response and resumes after a cap increase', async () => {
  const root = fixture(),
    memory = new Memory(root);
  memory.savePlan(PlanSchema.parse(plan));
  const responses = [
    {
      content: '',
      toolCalls: [
        {
          name: 'write' as const,
          args: { path: 'hello.txt', content: 'Hello Relay' },
        },
      ],
      usage: { tokens: 5, cost: 1 },
    },
    { content: 'done' },
    {
      content: JSON.stringify({
        criteria: [{ id: 'A1', passed: true, evidence: 'Greeting exists' }],
        summary: 'Verified',
      }),
    },
  ];
  const { MockProvider } = await import('../src/provider.js');
  const { Orchestrator } = await import('../src/orchestrator.js');
  const { defaultConfig } = await import('../src/schema.js');
  expect(
    (
      await new Orchestrator(
        root,
        { ...defaultConfig(), maxCost: 1 },
        new MockProvider(responses),
      ).run()
    ).reason,
  ).toContain('cap');
  expect(memory.checkpoint()?.pendingTools).toHaveLength(1);
  expect(
    (
      await new Orchestrator(
        root,
        { ...defaultConfig(), maxCost: 2 },
        new MockProvider(responses),
      ).run()
    ).completed,
  ).toBe(1);
});
