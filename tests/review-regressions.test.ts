import { expect, test } from 'vitest';
import { join } from 'node:path';
import { writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ToolRunner } from '../src/tools.js';
import { PlanSchema, defaultConfig } from '../src/schema.js';
import { Memory } from '../src/memory.js';
import { MockProvider } from '../src/provider.js';
import { Orchestrator } from '../src/orchestrator.js';
import { answer } from '../src/questions.js';
import { fixture, plan } from './helpers.js';
test('Git inspection cannot read arbitrary filesystem paths through diff options', async () => {
  const tools = new ToolRunner(fixture(), defaultConfig());
  await expect(
    tools.run({
      name: 'git',
      args: { argv: ['diff', '--no-index', '/etc/hostname', '/etc/passwd'] },
    }),
  ).rejects.toThrow();
});
test('verifier sees newly created, untracked file content', async () => {
  const memory = new Memory(fixture());
  memory.savePlan(PlanSchema.parse(plan));
  const mock = new MockProvider([
    {
      content: '',
      toolCalls: [
        {
          name: 'write',
          args: { path: 'hello.txt', content: 'Hello Relay NEWFILE' },
        },
      ],
    },
    { content: 'done' },
    {
      content: JSON.stringify({
        criteria: [{ id: 'A1', passed: true, evidence: 'New file reviewed' }],
        summary: 'Verified',
      }),
    },
  ]);
  let diff = '';
  const provider = {
    complete: async (req: Parameters<typeof mock.complete>[0]) => {
      if (req.role === 'verifier')
        diff = (JSON.parse(req.messages[1]!.content) as { diff: string }).diff;
      return mock.complete(req);
    },
  };
  await new Orchestrator(memory.root, defaultConfig(), provider).run();
  expect(diff).toContain('NEWFILE');
});
test('a published answer checkpoint survives an interruption before derived plan rendering', async () => {
  const memory = new Memory(fixture());
  memory.savePlan(PlanSchema.parse(plan));
  await new Orchestrator(
    memory.root,
    { ...defaultConfig(), maxAttempts: 1 },
    new MockProvider([{ content: 'done' }]),
  ).run();
  const save = memory.savePlan.bind(memory);
  memory.savePlan = () => {
    throw new Error('Simulated crash during render');
  };
  expect(() => answer(memory, 'T1', 'Write the actual file.')).toThrow(
    'Simulated crash',
  );
  memory.savePlan = save;
  const snapshot = memory.checkpoint()?.snapshotPlan;
  expect(snapshot?.milestones[0]?.tasks[0]?.status).toBe('todo');
  expect(snapshot?.milestones[0]?.tasks[0]?.notes.at(-1)).toContain(
    'Write the actual file',
  );
});
test('memory refuses a .relay symlink outside the repository', () => {
  const root = fixture();
  symlinkSync(tmpdir(), join(root, '.relay'));
  expect(() => new Memory(root)).toThrow();
});
test('Git hooks do not receive injected environment credentials', async () => {
  const root = fixture();
  writeFileSync(
    join(root, '.git/hooks/pre-commit'),
    `#!/bin/sh\necho hook-ran > ${join(root, 'hook-output')}\n`,
    { mode: 0o755 },
  );
  const memory = new Memory(root);
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
        criteria: [{ id: 'A1', passed: true, evidence: 'Greeting' }],
        summary: 'Verified',
      }),
    },
  ]);
  await new Orchestrator(root, defaultConfig(), provider).run();
  expect(() => readFileSync(join(root, 'hook-output'))).toThrow();
});
test('planner cannot create completed tasks without verification', async () => {
  const { revisePlan } = await import('../src/planner.js');
  const memory = new Memory(fixture());
  memory.savePlan(PlanSchema.parse(plan));
  const promoted = PlanSchema.parse(plan);
  promoted.milestones[0]!.tasks[0]!.status = 'done';
  expect(() => revisePlan(memory, promoted, 'Shortcut')).toThrow('unverified');
});
test('an interrupted empty lock from an older release can be recovered', async () => {
  const { RunLock } = await import('../src/lock.js');
  const memory = new Memory(fixture());
  memory.write('run.lock', '');
  const release = new RunLock(memory.dir).acquire();
  release();
});
test('command watchdog still enforces timeout after harness SIGKILL', async () => {
  const { spawn } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const root = fixture();
  writeFileSync(
    join(root, 'runaway.test.mjs'),
    "import {writeFileSync} from 'node:fs';writeFileSync('started','yes');setTimeout(()=>writeFileSync('too-late','unsafe'),2000);",
  );
  const parent = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      resolve('tests/command-crash-child.mjs'),
      root,
    ],
    { stdio: 'ignore' },
  );
  const deadline = Date.now() + 3000;
  while (!existsSync(join(root, 'started')) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(existsSync(join(root, 'started'))).toBe(true);
  parent.kill('SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 2100));
  expect(existsSync(join(root, 'too-late'))).toBe(false);
});
test('task deadline is checked between tool calls in a single model response', async () => {
  const { vi } = await import('vitest');
  const root = fixture(),
    memory = new Memory(root);
  memory.savePlan(PlanSchema.parse(plan));
  let calls = 0;
  const original = ToolRunner.prototype.run;
  const spy = vi
    .spyOn(ToolRunner.prototype, 'run')
    .mockImplementation(async function (this: ToolRunner, call, signal) {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 45));
      return original.call(this, call, signal);
    });
  try {
    const provider = new MockProvider([
      {
        content: '',
        toolCalls: Array.from({ length: 5 }, () => ({
          name: 'read' as const,
          args: { path: 'GOAL.md' },
        })),
      },
    ]);
    await new Orchestrator(
      root,
      { ...defaultConfig(), taskTimeoutMs: 130, maxAttempts: 1 },
      provider,
    ).run();
    expect(calls).toBeLessThan(5);
  } finally {
    spy.mockRestore();
  }
});
test('command results preserve failure status, truncate output and timeout', async () => {
  const root = fixture();
  writeFileSync(
    join(root, 'fail.test.mjs'),
    "import {test} from 'node:test';import assert from 'node:assert/strict';test('failure',()=>{console.log('x'.repeat(10000));assert.equal(1,2);});",
  );
  const tools = new ToolRunner(root, {
    ...defaultConfig(),
    maxOutputBytes: 100,
  });
  const result = await tools.command(['node', '--test', 'fail.test.mjs']);
  expect(result.code).not.toBe(0);
  expect(result.truncated).toBe(true);
  expect(
    Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
  ).toBeLessThanOrEqual(100);
});
test('aborting during previous-command recovery cannot launch a replacement command', async () => {
  const root = fixture(),
    memory = new Memory(root);
  memory.write(
    'active-command.json',
    JSON.stringify({
      hostPid: null,
      deadline: Date.now() + 150,
      nonce: '11111111-1111-4111-8111-111111111111',
    }),
  );
  writeFileSync(
    join(root, 'marker.test.mjs'),
    "import {writeFileSync} from 'node:fs';writeFileSync('unexpected','bad');",
  );
  const { existsSync } = await import('node:fs');
  await expect(
    new ToolRunner(root, defaultConfig()).command(
      ['node', '--test', 'marker.test.mjs'],
      AbortSignal.timeout(10),
    ),
  ).rejects.toThrow();
  expect(existsSync(join(root, 'unexpected'))).toBe(false);
});
