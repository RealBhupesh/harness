import { expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, plan, task } from './helpers.js';
import { ConfigSchema, PlanSchema, defaultConfig } from '../src/schema.js';
import { Memory } from '../src/memory.js';
import { MockProvider } from '../src/provider.js';
import { Orchestrator } from '../src/orchestrator.js';
import { main } from '../src/cli.js';
function project(count = 3) {
  const memory = new Memory(fixture());
  const tasks = Array.from({ length: count }, (_, i) => ({
    ...task,
    id: `T${i + 1}`,
    description: `Write hello${i + 1}.txt`,
    acceptance: [{ ...task.acceptance[0]!, path: `hello${i + 1}.txt` }],
  }));
  memory.savePlan(
    PlanSchema.parse({
      ...plan,
      milestones: [{ id: 'M1', title: 'Greeting files', tasks }],
    }),
  );
  const responses = Array.from({ length: count }, (_, i) => [
    {
      content: '',
      toolCalls: [
        {
          name: 'write' as const,
          args: { path: `hello${i + 1}.txt`, content: 'Hello Relay' },
        },
      ],
      usage: { tokens: 10, cost: 0 },
    },
    { content: 'done' },
    {
      content: JSON.stringify({
        criteria: [{ id: 'A1', passed: true, evidence: 'Greeting verified' }],
        summary: 'Verified',
      }),
    },
  ]).flat();
  return { memory, provider: new MockProvider(responses) };
}
test('autonomy completes real checkpointed task batches without resetting usage', async () => {
  const { runAutomatically } = await import('../src/autonomy.js');
  const { memory, provider } = project();
  const config = { ...defaultConfig(), maxTasks: 3 },
    sizes: number[] = [];
  const result = await runAutomatically(
    memory,
    config,
    async (max) => {
      sizes.push(max);
      return new Orchestrator(memory.root, config, provider).run(max);
    },
    3,
    1,
  );
  expect(result.completed).toBe(3);
  expect(result.reason).toContain('complete');
  expect(sizes).toEqual([1, 1, 1]);
  expect(memory.checkpoint()!.usage.tokens).toBe(30);
  expect(readFileSync(join(memory.root, 'hello3.txt'), 'utf8')).toBe(
    'Hello Relay',
  );
});
test('automatic continuation stops at cumulative budget instead of starting another batch', async () => {
  const { runAutomatically } = await import('../src/autonomy.js');
  const { memory, provider } = project();
  const config = { ...defaultConfig(), maxTokens: 15, maxTasks: 3 };
  let batches = 0;
  const result = await runAutomatically(
    memory,
    config,
    async (max) => {
      batches++;
      return new Orchestrator(memory.root, config, provider).run(max);
    },
    3,
    1,
  );
  expect(batches).toBe(2);
  expect(result.completed).toBe(1);
  expect(result.reason).toMatch(/cap|budget/i);
  expect(memory.checkpoint()!.usage.tokens).toBe(20);
});
test('automatic continuation preserves a quota-paused task without busy retries', async () => {
  const { runAutomatically } = await import('../src/autonomy.js');
  const { ProviderPaused } = await import('../src/cli-provider.js');
  const { memory } = project();
  let calls = 0,
    batches = 0;
  const provider = {
    complete: async () => {
      calls++;
      throw new ProviderPaused('Subscription quota reached');
    },
  };
  const config = defaultConfig();
  const result = await runAutomatically(
    memory,
    config,
    async (max) => {
      batches++;
      return new Orchestrator(memory.root, config, provider).run(max);
    },
    10,
    1,
  );
  expect(calls).toBe(1);
  expect(batches).toBe(1);
  expect(result.reason).toContain('quota');
  expect(memory.checkpoint()!.taskId).toBe('T1');
  expect(memory.loadPlan().milestones[0]!.tasks[0]!.attempts).toBe(1);
});
test('automatic total attempt limit counts failures, not only completions', async () => {
  const { runAutomatically } = await import('../src/autonomy.js');
  const { memory } = project();
  const config = defaultConfig();
  let calls = 0;
  const provider = {
    mock: true,
    complete: async () => {
      calls++;
      throw new Error('Failed worker');
    },
  };
  const result = await runAutomatically(
    memory,
    config,
    (max) => new Orchestrator(memory.root, config, provider).run(max),
    2,
    1,
  );
  expect(calls).toBe(2);
  expect(result.completed).toBe(0);
  expect(memory.loadPlan().milestones[0]!.tasks[0]!.attempts).toBe(2);
});
test('economy hybrid profile routes workers to Codex and independent reviews to Claude', async () => {
  const { economyProfile } = await import('../src/profiles.js');
  const config = economyProfile('hybrid');
  expect(config.provider).toBe('codex-cli');
  expect(config.roleProviders.verifier).toBe('claude-cli');
  expect(config.models.verifier).toBe('sonnet');
  expect(config.context.maxPromptBytes).toBeLessThan(48000);
  expect(config.cli.effort.worker).toBe('low');
  expect(config.parallel).toBe(1);
});
test('economy profile respects existing tighter spending and context caps', async () => {
  const { economyProfile } = await import('../src/profiles.js');
  const config = economyProfile(
    'codex-cli',
    ConfigSchema.parse({
      maxCost: 1,
      maxTokens: 5000,
      maxTasks: 2,
      context: { maxPromptBytes: 4000 },
      roleOutputTokens: { worker: 300 },
    }),
  );
  expect(config.maxCost).toBe(1);
  expect(config.maxTokens).toBe(5000);
  expect(config.maxTasks).toBe(2);
  expect(config.context.maxPromptBytes).toBe(4000);
  expect(config.roleOutputTokens.worker).toBe(300);
});
test('CLI economy initialization is explicit and never overwrites existing config', async () => {
  const root = fixture(),
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await main(
      ['init', '--profile', 'economy', '--provider', 'codex-cli'],
      root,
    );
    const memory = new Memory(root),
      original = memory.read('config.json');
    expect(JSON.parse(original).provider).toBe('codex-cli');
    await main(
      ['init', '--profile', 'economy', '--provider', 'claude-cli'],
      root,
    );
    expect(memory.read('config.json')).toBe(original);
  } finally {
    log.mockRestore();
  }
});
test('CLI auto executes an existing real plan with the original mock cursor', async () => {
  const { memory, provider } = project(1);
  void provider;
  memory.write('config.json', JSON.stringify(defaultConfig()));
  memory.write(
    'mock.json',
    JSON.stringify([
      {
        content: '',
        toolCalls: [
          {
            name: 'write',
            args: { path: 'hello1.txt', content: 'Hello Relay' },
          },
        ],
      },
      { content: 'done' },
      {
        content: JSON.stringify({
          criteria: [{ id: 'A1', passed: true, evidence: 'Greeting checked' }],
          summary: 'Verified',
        }),
      },
    ]),
  );
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await main(['auto', '--max-tasks', '1'], memory.root);
    expect(memory.loadPlan().milestones[0]!.tasks[0]!.status).toBe('done');
  } finally {
    log.mockRestore();
  }
});

test('auto planning shares its charged usage and mock cursor with task execution', async () => {
  const root = fixture(),
    memory = new Memory(root),
    config = { ...defaultConfig(), maxTokens: 15 };
  memory.write('config.json', JSON.stringify(config));
  memory.write(
    'mock.json',
    JSON.stringify([
      { content: JSON.stringify(plan), usage: { tokens: 10, cost: 0 } },
      {
        content: '',
        toolCalls: [
          {
            name: 'write',
            args: { path: 'hello.txt', content: 'Hello Relay' },
          },
        ],
        usage: { tokens: 10, cost: 0 },
      },
      { content: 'done' },
      {
        content: JSON.stringify({
          criteria: [{ id: 'A1', passed: true, evidence: 'Greeting checked' }],
          summary: 'Verified',
        }),
      },
    ]),
  );
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await main(['auto', '--max-tasks', '1'], root);
    expect(memory.checkpoint()!.usage.tokens).toBe(20);
    expect(memory.checkpoint()!.mockCursor).toBe(2);
    expect(memory.loadPlan().milestones[0]!.tasks[0]!.status).toBe(
      'in_progress',
    );
  } finally {
    log.mockRestore();
  }
});

test('planning time is included in the cumulative wall-time budget', async () => {
  const { generatePlan } = await import('../src/planning.js');
  const memory = new Memory(fixture());
  const provider = {
    mock: true,
    complete: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return {
        content: JSON.stringify(plan),
        toolCalls: [],
        usage: { tokens: 1, cost: 0 },
      };
    },
  };
  await generatePlan(memory, defaultConfig(), provider);
  expect(memory.checkpoint()!.activeWallMs).toBeGreaterThanOrEqual(30);
});

test('replanning after terminal parallel work preserves new planner charges in both checkpoints', async () => {
  const { generatePlan } = await import('../src/planning.js');
  const { CheckpointSchema } = await import('../src/schema.js');
  const memory = new Memory(fixture()),
    cp = CheckpointSchema.parse({
      phase: 'SELECT',
      taskId: null,
      baseBranch: null,
      branch: null,
      baseSha: null,
      runId: 'parallel-finished',
      completed: 0,
      messages: [],
      steps: 0,
      taskStarted: 0,
      stopReason: null,
      snapshotPlan: plan,
      usage: { tokens: 100, cost: 0 },
    });
  memory.savePlan(PlanSchema.parse(plan));
  memory.saveCheckpoint(cp);
  memory.write(
    'parallel.json',
    JSON.stringify({ width: 2, plan, checkpoint: cp, entries: [] }),
  );
  await generatePlan(
    memory,
    defaultConfig(),
    new MockProvider([
      { content: JSON.stringify(plan), usage: { tokens: 25, cost: 0 } },
    ]),
  );
  const journal = JSON.parse(memory.read('parallel.json')) as {
    checkpoint: typeof cp;
  };
  expect(memory.checkpoint()!.usage.tokens).toBe(125);
  expect(journal.checkpoint.usage.tokens).toBe(125);
  expect(journal.checkpoint.chargedPlanningCalls).toHaveLength(1);
  expect(journal.checkpoint.mockCursor).toBe(1);
});
test('automatic attempt caps include a resumed attempt that fails', async () => {
  const { runAutomatically } = await import('../src/autonomy.js');
  const { ProviderPaused } = await import('../src/cli-provider.js');
  const { memory } = project();
  const config = { ...defaultConfig(), maxTasks: 5 };
  await new Orchestrator(memory.root, config, {
    mock: true,
    complete: async () => {
      throw new ProviderPaused('pause');
    },
  }).run(1);
  let calls = 0;
  const failing = {
    mock: true,
    complete: async () => {
      calls++;
      throw new Error('failure');
    },
  };
  await runAutomatically(
    memory,
    config,
    (max) => new Orchestrator(memory.root, config, failing).run(max),
    5,
    5,
  );
  expect(calls).toBe(5);
});

test('automatic parallel attempt caps include resumed failures', async () => {
  const { runAutomatically } = await import('../src/autonomy.js');
  const { ProviderPaused } = await import('../src/cli-provider.js');
  const { ParallelCoordinator } = await import('../src/parallel.js');
  const { memory } = project();
  const config = { ...defaultConfig(), maxTasks: 5, parallel: 2 };
  await new ParallelCoordinator(memory.root, config, () => ({
    mock: true,
    complete: async () => {
      throw new ProviderPaused('pause');
    },
  })).run(2, 2);
  let calls = 0;
  const factory = () => ({
    mock: true,
    complete: async () => {
      calls++;
      throw new Error('failure');
    },
  });
  await runAutomatically(
    memory,
    config,
    (max) => new ParallelCoordinator(memory.root, config, factory).run(2, max),
    5,
    5,
  );
  expect(calls).toBe(5);
});
