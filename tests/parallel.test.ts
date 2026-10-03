import { expect, test } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, plan } from './helpers.js';
import { PlanSchema, defaultConfig, type Task } from '../src/schema.js';
import { Memory } from '../src/memory.js';
import { MockProvider } from '../src/provider.js';
import { ParallelCoordinator } from '../src/parallel.js';
import { Git } from '../src/git.js';
import { RunLock } from '../src/lock.js';
import { answer } from '../src/questions.js';
import { revisePlan } from '../src/planner.js';
const make = (task: Task) =>
  new MockProvider([
    {
      content: '',
      toolCalls: [
        {
          name: 'write',
          args: { path: `${task.id}.txt`, content: 'Hello Relay' },
        },
      ],
    },
    { content: 'done' },
    {
      content: JSON.stringify({
        criteria: [{ id: 'A1', passed: true, evidence: 'Greeting present' }],
        summary: 'Verified',
      }),
    },
  ]);
test('independent task workers overlap and verified commits merge serially', async () => {
  const memory = new Memory(fixture());
  const p = PlanSchema.parse(plan);
  p.milestones[0]!.tasks[0]!.acceptance = [
    {
      id: 'A1',
      description: 'First',
      kind: 'fileContains',
      path: 'T1.txt',
      text: 'Hello Relay',
    },
  ];
  p.milestones[0]!.tasks.push({
    ...p.milestones[0]!.tasks[0]!,
    id: 'T2',
    acceptance: [
      {
        id: 'A1',
        description: 'Second',
        kind: 'fileContains',
        path: 'T2.txt',
        text: 'Hello Relay',
      },
    ],
  });
  memory.savePlan(p);
  let active = 0,
    peak = 0;
  const factory = (task: Task) => {
    const inner = make(task);
    return {
      complete: async (req: Parameters<typeof inner.complete>[0]) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        try {
          return await inner.complete(req);
        } finally {
          active--;
        }
      },
    };
  };
  expect(
    (
      await new ParallelCoordinator(memory.root, defaultConfig(), factory).run(
        2,
        2,
      )
    ).completed,
  ).toBe(2);
  expect(peak).toBe(2);
  expect(
    memory.loadPlan().milestones[0]?.tasks.every((t) => t.status === 'done'),
  ).toBe(true);
  expect(readFileSync(join(memory.root, 'T2.txt'), 'utf8')).toBe('Hello Relay');
});
test('merge coordinator reverts an integration regression and records blockers', async () => {
  const root = fixture(),
    memory = new Memory(root);
  writeFileSync(
    join(root, 'integration.test.mjs'),
    "import { test } from 'node:test';import assert from 'node:assert/strict';import {existsSync} from 'node:fs';test('compatible',()=>assert.equal(existsSync('T1.txt')&&existsSync('T2.txt'),false));",
  );
  const git = new Git(root);
  git.run(['add', '.']);
  git.run(['commit', '-m', 'test: integration guard']);
  const p = PlanSchema.parse(plan);
  p.milestones[0]!.tasks = p.milestones[0]!.tasks.concat([
    { ...p.milestones[0]!.tasks[0]!, id: 'T2' },
  ]).map((t) => ({
    ...t,
    acceptance: [
      {
        id: 'A1',
        description: 'Greeting',
        kind: 'fileContains' as const,
        path: `${t.id}.txt`,
        text: 'Hello Relay',
      },
    ],
  }));
  memory.savePlan(p);
  const result = await new ParallelCoordinator(
    root,
    {
      ...defaultConfig(),
      maxAttempts: 1,
      verificationCommands: [['node', '--test', 'integration.test.mjs']],
    },
    make,
  ).run(2, 2);
  expect(result.completed).toBe(1);
  expect(
    memory.loadPlan().milestones[0]?.tasks.find((t) => t.id === 'T2')?.status,
  ).toBe('blocked');
  expect(git.run(['log', '-1', '--format=%s'])).toContain('revert');
  expect(memory.read('QUESTIONS.md')).toContain('regression');
});
for (const mode of [
  'workers',
  'merge',
  'rollback',
  'changed',
  'merge-budget',
  'narrow',
]) {
  test(`parallel coordinator recovers SIGKILL during ${mode}`, async () => {
    const { spawnSync } = await import('node:child_process');
    const { resolve } = await import('node:path');
    const root = fixture(),
      memory = new Memory(root),
      p = PlanSchema.parse(plan);
    p.milestones[0]!.tasks = p.milestones[0]!.tasks.concat([
      { ...p.milestones[0]!.tasks[0]!, id: 'T2' },
    ]).map((t) => ({
      ...t,
      acceptance: [
        {
          id: 'A1',
          description: 'Greeting',
          kind: 'fileContains' as const,
          path: `${t.id}.txt`,
          text: 'Hello Relay',
        },
      ],
    }));
    memory.savePlan(p);
    if (mode === 'rollback') {
      writeFileSync(
        join(root, 'integration.test.mjs'),
        "import {test} from 'node:test';import assert from 'node:assert/strict';import {existsSync} from 'node:fs';test('compatibility',()=>assert.equal(existsSync('T1.txt')&&existsSync('T2.txt'),false));",
      );
      const git = new Git(root);
      git.run(['add', '.']);
      git.run(['commit', '-m', 'integration guard']);
      memory.write(
        'config.json',
        JSON.stringify({
          verificationCommands: [['node', '--test', 'integration.test.mjs']],
        }),
      );
    }
    for (const task of p.milestones[0]!.tasks)
      memory.write(
        `mock-${task.id}.json`,
        JSON.stringify([
          {
            content: '',
            toolCalls: [
              {
                name: 'write',
                args: { path: `${task.id}.txt`, content: 'Hello Relay' },
              },
            ],
          },
          { content: 'done' },
          {
            content: JSON.stringify({
              criteria: [
                { id: 'A1', passed: true, evidence: 'Greeting present' },
              ],
              summary: 'Verified',
            }),
          },
        ]),
      );
    const args = [
      '--import',
      import.meta.resolve('tsx'),
      resolve('tests/parallel-crash-child.mjs'),
      root,
      mode === 'changed' || mode === 'narrow'
        ? 'workers'
        : mode === 'merge-budget'
          ? 'merge'
          : mode,
    ];
    const killed = spawnSync(process.execPath, args, { encoding: 'utf8' });
    expect(
      killed.signal,
      killed.stderr + killed.stdout + memory.read('parallel.json'),
    ).toBe('SIGKILL');
    if (mode === 'changed') {
      const journal = JSON.parse(memory.read('parallel.json')) as {
        entries: { branch: string; stage: string }[];
      };
      const entry = journal.entries.find((e) => e.stage === 'verified')!;
      const path = new Git(root).worktree(entry.branch),
        workerGit = new Git(path);
      writeFileSync(join(path, 'unverified.txt'), 'Additional change');
      workerGit.run(['add', 'unverified.txt']);
      workerGit.run(['commit', '-m', 'extra change after verification']);
    }
    if (mode === 'rollback' || mode === 'merge-budget') {
      const config = JSON.parse(memory.read('config.json') || '{}');
      memory.write(
        'config.json',
        JSON.stringify({ ...config, maxWallTimeMs: 1 }),
      );
    }
    if (mode === 'narrow') args.push('1');
    const resumed = spawnSync(process.execPath, args, { encoding: 'utf8' });
    expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
    expect(
      memory.loadPlan().milestones[0]!.tasks.filter((t) => t.status === 'done'),
    ).toHaveLength(
      mode === 'merge-budget'
        ? 0
        : mode === 'rollback' || mode === 'changed' || mode === 'narrow'
          ? 1
          : 2,
    );
    if (mode === 'narrow') {
      const again = spawnSync(process.execPath, args, { encoding: 'utf8' });
      expect(again.status, again.stderr + again.stdout).toBe(0);
      expect(
        memory
          .loadPlan()
          .milestones[0]!.tasks.filter((t) => t.status === 'done'),
      ).toHaveLength(2);
    }
    if (mode === 'merge-budget')
      expect(new Git(root).run(['log', '-1', '--format=%s'])).toContain(
        'revert',
      );
    if (mode === 'changed')
      expect(
        new Git(root).run(['ls-tree', '--name-only', 'HEAD']),
      ).not.toContain('unverified.txt');
  });
}

test('unaccounted durable worker spend is charged before granting resumed budgets', async () => {
  const { spawnSync } = await import('node:child_process');
  const { resolve } = await import('node:path');
  const root = fixture(),
    memory = new Memory(root);
  memory.savePlan(PlanSchema.parse(plan));
  memory.write('config.json', JSON.stringify({ maxCost: 1 }));
  memory.write(
    'mock-T1.json',
    JSON.stringify([{ content: 'done', usage: { tokens: 1, cost: 1 } }]),
  );
  const args = [
    '--import',
    import.meta.resolve('tsx'),
    resolve('tests/parallel-crash-child.mjs'),
    root,
    'spent',
  ];
  const killed = spawnSync(process.execPath, args, { encoding: 'utf8' });
  expect(killed.signal, killed.stderr + killed.stdout).toBe('SIGKILL');
  expect(memory.checkpoint()?.usage.cost).toBe(0);
  let calls = 0;
  const result = await new ParallelCoordinator(
    root,
    { ...defaultConfig(), maxCost: 1 },
    () => ({
      complete: async () => {
        calls++;
        throw new Error('No budget remains');
      },
    }),
  ).run(2, 2);
  expect(result.reason).toContain('budget');
  expect(calls).toBe(0);
  expect(memory.checkpoint()?.usage.cost).toBe(1);
});

test('merge checks that mutate an artifact pause without claiming completion', async () => {
  const root = fixture(),
    memory = new Memory(root),
    git = new Git(root);
  writeFileSync(
    join(root, 'mutating.test.mjs'),
    "import {test} from 'node:test';import {existsSync,writeFileSync} from 'node:fs';test('check',()=>{if(existsSync('T1.txt'))writeFileSync('checked.txt','changed')});",
  );
  git.run(['add', '.']);
  git.run(['commit', '-m', 'test: mutation guard']);
  const p = PlanSchema.parse(plan),
    task = p.milestones[0]!.tasks[0]!;
  task.acceptance[0] = {
    id: 'A1',
    description: 'Greeting',
    kind: 'fileContains',
    path: 'T1.txt',
    text: 'Hello Relay',
  };
  memory.savePlan(p);
  // Worker checks create and commit checked.txt. During merge checks it changes again.
  writeFileSync(
    join(root, 'mutating.test.mjs'),
    "import {test} from 'node:test';import {existsSync,readFileSync,writeFileSync} from 'node:fs';test('check',()=>{if(existsSync('T1.txt'))writeFileSync('checked.txt',String(Number(existsSync('checked.txt')?readFileSync('checked.txt','utf8'):0)+1))});",
  );
  git.run(['add', 'mutating.test.mjs']);
  git.run(['commit', '-m', 'test: increment checked artifact']);
  const result = await new ParallelCoordinator(
    root,
    {
      ...defaultConfig(),
      verificationCommands: [['node', '--test', 'mutating.test.mjs']],
    },
    make,
  ).run(2, 1);
  expect(result.completed).toBe(0);
  expect(result.reason).toContain('changed the checkout');
  expect(memory.loadPlan().milestones[0]!.tasks[0]!.status).toBe('in_progress');
  expect(git.run(['show', 'HEAD:checked.txt'])).toBe('1');
  expect(readFileSync(join(root, 'checked.txt'), 'utf8')).toBe('2');
});

test('human mutations use authoritative journal state and respect the coordinator lock', () => {
  const memory = new Memory(fixture()),
    stale = PlanSchema.parse(plan),
    current = PlanSchema.parse(plan);
  stale.milestones[0]!.tasks[0]!.status = 'blocked';
  current.milestones[0]!.tasks[0]!.status = 'done';
  memory.savePlan(stale);
  memory.write(
    'parallel.json',
    JSON.stringify({ plan: current, entries: [], checkpoint: {} }),
  );
  expect(() => answer(memory, 'T1', 'retry')).toThrow('blocked task');
  expect(() => revisePlan(memory, stale, 'retry')).toThrow('completed task');
  const release = new RunLock(memory.dir).acquire();
  try {
    expect(() => answer(memory, 'T1', 'retry')).toThrow(/active|running/i);
  } finally {
    release();
  }
  expect(memory.committedPlan().milestones[0]!.tasks[0]!.status).toBe('done');
});

test('conflicting verified branches preserve the rejected attempt and requeue it', async () => {
  const root = fixture(),
    memory = new Memory(root),
    p = PlanSchema.parse(plan);
  const first = p.milestones[0]!.tasks[0]!;
  first.acceptance[0] = {
    id: 'A1',
    description: 'Greeting',
    kind: 'fileContains',
    path: 'shared.txt',
    text: 'Hello Relay',
  };
  p.milestones[0]!.tasks.push({ ...first, id: 'T2' });
  memory.savePlan(p);
  const factory = (task: Task) =>
    new MockProvider([
      {
        content: '',
        toolCalls: [
          {
            name: 'write',
            args: { path: 'shared.txt', content: `Hello Relay ${task.id}` },
          },
        ],
      },
      { content: 'done' },
      {
        content: JSON.stringify({
          criteria: [{ id: 'A1', passed: true, evidence: 'Greeting present' }],
          summary: 'Verified',
        }),
      },
    ]);
  const result = await new ParallelCoordinator(
    root,
    defaultConfig(),
    factory,
  ).run(2, 2);
  expect(result.completed).toBe(1);
  const rejected = memory
    .loadPlan()
    .milestones[0]!.tasks.find((task) => task.id === 'T2')!;
  expect(rejected.status).toBe('todo');
  expect(rejected.notes.join('\n')).toContain('Merge conflict');
  expect(new Git(root).changes()).toEqual([]);
});
