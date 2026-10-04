import { expect, test } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, plan } from './helpers.js';
import { ConfigSchema, PlanSchema, defaultConfig } from '../src/schema.js';
import { Memory } from '../src/memory.js';
import { MockProvider, type Request } from '../src/provider.js';
import { Orchestrator } from '../src/orchestrator.js';
import { ToolRunner } from '../src/tools.js';
import { verify } from '../src/verifier.js';
import { workerPrompt, compactText } from '../src/prompts.js';

test('large write payloads do not get echoed in subsequent worker prompts', async () => {
  const memory = new Memory(fixture());
  memory.savePlan(PlanSchema.parse(plan));
  const content = `Hello Relay\n${'unnecessary-repeat '.repeat(1500)}`;
  const inner = new MockProvider([
    {
      content: '',
      toolCalls: [{ name: 'write', args: { path: 'hello.txt', content } }],
    },
    { content: 'done' },
    {
      content: JSON.stringify({
        criteria: [{ id: 'A1', passed: true, evidence: 'Greeting checked' }],
        summary: 'Verified',
      }),
    },
  ]);
  const requests: Request[] = [];
  const provider = {
    mock: true,
    complete: async (req: Request) => {
      requests.push({ ...req, messages: structuredClone(req.messages) });
      return inner.complete(req);
    },
  };
  const result = await new Orchestrator(
    memory.root,
    defaultConfig(),
    provider,
  ).run();
  expect(result.completed).toBe(1);
  expect(
    Buffer.byteLength(
      JSON.stringify(requests.filter((r) => r.role === 'worker')[1]!.messages),
    ),
  ).toBeLessThan(10000);
  expect(
    memory
      .checkpoint()!
      .messages.map((m) => m.content)
      .join('\n'),
  ).toContain(content.replaceAll('\n', '\\n'));
  const { TraceStore } = await import('../src/trace.js');
  const trace = new TraceStore(memory.dir);
  try {
    const recorded = trace
      .events('T1')
      .filter((e) => e.kind === 'llm')
      .map(
        (e) =>
          JSON.parse(e.payload) as {
            promptStats?: { originalBytes: number; sentBytes: number };
          },
      );
    expect(recorded[1]!.promptStats!.originalBytes).toBeGreaterThan(50000);
    expect(recorded[1]!.promptStats!.sentBytes).toBeLessThan(10000);
  } finally {
    trace.close();
  }
});

test('bounded worker context preserves criteria and the latest failed command', async () => {
  const root = fixture(),
    memory = new Memory(root);
  memory.savePlan(PlanSchema.parse(plan));
  writeFileSync(join(root, 'noise.txt'), 'noise '.repeat(2000));
  writeFileSync(
    join(root, 'broken.test.mjs'),
    "import {test} from 'node:test';test('diagnostic',()=>{throw new Error('CRITICAL_FAILURE_DETAIL')});",
  );
  const { Git } = await import('../src/git.js');
  const git = new Git(root);
  git.run(['add', 'noise.txt', 'broken.test.mjs']);
  git.run(['commit', '-m', 'test fixture']);
  const script = [
    {
      content: '',
      toolCalls: [
        {
          name: 'command' as const,
          args: { argv: ['node', '--test', 'broken.test.mjs'] },
        },
      ],
    },
    ...Array.from({ length: 8 }, () => ({
      content: '',
      toolCalls: [{ name: 'read' as const, args: { path: 'noise.txt' } }],
    })),
    {
      content: '',
      toolCalls: [
        {
          name: 'write' as const,
          args: { path: 'hello.txt', content: 'Hello Relay' },
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
  ];
  const inner = new MockProvider(script),
    requests: Request[] = [];
  const provider = {
    mock: true,
    complete: async (req: Request) => {
      requests.push({ ...req, messages: structuredClone(req.messages) });
      return inner.complete(req);
    },
  };
  const config = ConfigSchema.parse({
    verificationCommands: [],
    context: { maxPromptBytes: 4000, maxEntryBytes: 1500 },
  });
  expect((await new Orchestrator(root, config, provider).run()).completed).toBe(
    1,
  );
  const workers = requests.filter((r) => r.role === 'worker');
  for (const req of workers)
    expect(Buffer.byteLength(JSON.stringify(req.messages))).toBeLessThanOrEqual(
      4000,
    );
  const final = JSON.stringify(workers.at(-1)!.messages);
  expect(final).toContain('Greeting exists');
  expect(final).toContain('CRITICAL_FAILURE_DETAIL');
  expect(final).toContain('omitted');
});

test('paged reads retrieve later file content and reject invalid ranges', async () => {
  const root = fixture(),
    tools = new ToolRunner(root, defaultConfig());
  writeFileSync(
    join(root, 'large.txt'),
    Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n'),
  );
  const page = await tools.run({
    name: 'read',
    args: { path: 'large.txt', startLine: 400, maxLines: 2 },
  });
  expect(page).toContain('line 400\nline 401');
  expect(page).not.toContain('line 399');
  await expect(
    tools.run({ name: 'read', args: { path: 'large.txt', startLine: 0 } }),
  ).rejects.toThrow();
});

test('verifier receives bounded success evidence while full command output remains available', async () => {
  const root = fixture(),
    tools = new ToolRunner(root, defaultConfig());
  writeFileSync(join(root, 'hello.txt'), 'Hello Relay');
  writeFileSync(
    join(root, 'verbose.test.mjs'),
    "import {test} from 'node:test';test('verbose',()=>console.log('VERIFIED_OUTPUT '.repeat(1000)));",
  );
  const task = PlanSchema.parse(plan).milestones[0]!.tasks[0]!;
  const requests: Request[] = [];
  const provider = {
    complete: async (req: Request) => {
      requests.push(req);
      return {
        content: JSON.stringify({
          criteria: [{ id: 'A1', passed: true, evidence: 'Greeting checked' }],
          summary: 'Verified',
        }),
        toolCalls: [],
        usage: { tokens: 0, cost: 0 },
      };
    },
  };
  const evidence = await verify(
    task,
    tools,
    provider,
    {
      ...defaultConfig(),
      verificationCommands: [['node', '--test', 'verbose.test.mjs']],
    },
    () => ({ diff: '+Hello Relay', tree: 'pinned-tree' }),
  );
  expect(evidence[0]!.output.length).toBeGreaterThan(10000);
  expect(Buffer.byteLength(JSON.stringify(requests[0]!.messages))).toBeLessThan(
    5000,
  );
  expect(JSON.stringify(requests[0]!.messages)).toContain('sha256');
});

test('long command diagnostics retain the failure in the middle of noisy output', () => {
  const messages = [
    { role: 'system' as const, content: 'Instructions' },
    { role: 'user' as const, content: 'Task and acceptance criteria' },
    {
      role: 'user' as const,
      content: JSON.stringify({
        tool: 'command',
        args: { argv: ['node', '--test'] },
        result: JSON.stringify({
          code: 1,
          stdout:
            'noise\n'.repeat(1000) +
            'Error: CRITICAL_MIDDLE_FAILURE\n' +
            'noise\n'.repeat(1000),
          stderr: '',
          truncated: false,
        }),
      }),
    },
  ];
  const prompt = workerPrompt(
    messages,
    ConfigSchema.parse({
      context: { maxPromptBytes: 4000, maxEntryBytes: 1200 },
    }),
  );
  expect(JSON.stringify(prompt.messages)).toContain('CRITICAL_MIDDLE_FAILURE');
  expect(
    Buffer.byteLength(JSON.stringify(prompt.messages)),
  ).toBeLessThanOrEqual(4000);
});

test('UTF-8 previews obey byte limits without splitting characters', () => {
  const preview = compactText('🙂漢字'.repeat(1000), 256);
  expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(256);
  expect(preview).not.toContain('\uFFFD');
  expect(preview).toContain('sha256');
});

test('oversized essential task context pauses before calling the model', async () => {
  const memory = new Memory(fixture()),
    p = PlanSchema.parse(plan);
  p.milestones[0]!.tasks[0]!.description = 'Essential constraint '.repeat(1000);
  memory.savePlan(p);
  let calls = 0;
  const provider = {
    mock: true,
    complete: async () => {
      calls++;
      throw new Error('Should not call');
    },
  };
  const result = await new Orchestrator(
    memory.root,
    ConfigSchema.parse({
      verificationCommands: [],
      context: { maxPromptBytes: 2048 },
    }),
    provider,
  ).run();
  expect(calls).toBe(0);
  expect(result.reason).toContain('Essential task');
  expect(memory.loadPlan().milestones[0]!.tasks[0]!.status).toBe('in_progress');
  expect(memory.checkpoint()!.messages[1]!.content).toContain(
    'Essential constraint '.repeat(1000),
  );
});

test('SIGKILL replays a compacted prompt response without duplicate calls or spending', async () => {
  const { spawnSync } = await import('node:child_process');
  const { resolve } = await import('node:path');
  const { TraceStore } = await import('../src/trace.js');
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
            args: {
              path: 'hello.txt',
              content: `Hello Relay\n${'noise '.repeat(4000)}`,
            },
          },
        ],
      },
      { content: 'done', usage: { tokens: 10, cost: 1 } },
      {
        content: JSON.stringify({
          criteria: [{ id: 'A1', passed: true, evidence: 'Greeting checked' }],
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
    'prompt',
  ];
  const killed = spawnSync(process.execPath, args, { encoding: 'utf8' });
  expect(killed.signal, killed.stderr).toBe('SIGKILL');
  memory.write('config.json', JSON.stringify({ context: { enabled: false } }));
  const resumed = spawnSync(process.execPath, args, { encoding: 'utf8' });
  expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
  expect(memory.loadPlan().milestones[0]!.tasks[0]!.status).toBe('done');
  expect(memory.checkpoint()!.usage.cost).toBe(1);
  const trace = new TraceStore(memory.dir);
  try {
    expect(trace.events('T1').filter((e) => e.kind === 'llm')).toHaveLength(3);
  } finally {
    trace.close();
  }
});

test('file evidence retains the matching excerpt even when the artifact is JSON', async () => {
  const root = fixture(),
    tools = new ToolRunner(root, defaultConfig()),
    task = PlanSchema.parse(plan).milestones[0]!.tasks[0]!;
  const artifact = JSON.stringify({
    padding: 'x'.repeat(4000),
    required: 'MATCH_HERE',
    tail: 'y'.repeat(4000),
  });
  writeFileSync(join(root, 'artifact.json'), artifact);
  task.acceptance = [
    {
      id: 'A1',
      description: 'Required JSON content',
      kind: 'fileContains',
      path: 'artifact.json',
      text: 'MATCH_HERE',
    },
  ];
  let output = '';
  const provider = {
    complete: async (req: Request) => {
      output = (
        JSON.parse(req.messages[1]!.content) as {
          evidence: { output: string }[];
        }
      ).evidence[0]!.output;
      return {
        content: JSON.stringify({
          criteria: [
            { id: 'A1', passed: true, evidence: 'Required JSON content found' },
          ],
          summary: 'Verified',
        }),
        toolCalls: [],
        usage: { tokens: 0, cost: 0 },
      };
    },
  };
  await verify(task, tools, provider, defaultConfig(), () => ({
    diff: 'JSON artifact changed',
    tree: 'tree',
  }));
  expect(output).toContain('MATCH_HERE');
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(1200);
});

test('context opt-out preserves the original initial context and failure notes', async () => {
  const root = fixture(),
    memory = new Memory(root),
    p = PlanSchema.parse(plan);
  const learnings = 'Learning '.repeat(60),
    convention = 'Convention '.repeat(40),
    note = 'Attempt 1 failed: ' + 'Details '.repeat(60);
  memory.write('LEARNINGS.md', learnings);
  p.milestones[0]!.tasks[0]!.notes = [note];
  memory.savePlan(p);
  writeFileSync(join(root, 'AGENTS.md'), convention);
  const { Git } = await import('../src/git.js');
  const git = new Git(root);
  git.run(['add', 'AGENTS.md']);
  git.run(['commit', '-m', 'test conventions']);
  let context:
    | { learnings: string; conventions: string; task: { notes: string[] } }
    | undefined;
  const inner = new MockProvider([{ content: 'done' }]);
  const provider = {
    mock: true,
    complete: async (req: Request) => {
      context = JSON.parse(req.messages[1]!.content);
      return inner.complete(req);
    },
  };
  await new Orchestrator(
    root,
    ConfigSchema.parse({
      maxAttempts: 1,
      verificationCommands: [],
      context: { enabled: false, maxEntryBytes: 256 },
    }),
    provider,
  ).run();
  expect(context!.learnings).toBe(learnings);
  expect(context!.conventions).toContain(convention);
  expect(context!.task.notes).toEqual([note]);
});

test('paged reads enforce UTF-8 byte limits without splitting characters', async () => {
  const root = fixture(),
    tools = new ToolRunner(root, ConfigSchema.parse({ maxOutputBytes: 1024 }));
  writeFileSync(join(root, 'unicode.txt'), '🙂'.repeat(500));
  const page = await tools.run({
    name: 'read',
    args: { path: 'unicode.txt', startLine: 1, maxLines: 1 },
  });
  expect(Buffer.byteLength(page)).toBeLessThanOrEqual(1024);
  expect(page).not.toContain('\ufffd');
  expect(page).toBe('🙂'.repeat(256));
});

test('paid live-provider responses recover before new-call budget reservations', async () => {
  const { BudgetProvider } = await import('../src/budget.js');
  const { TracedProvider, TraceStore } = await import('../src/trace.js');
  const memory = new Memory(fixture()),
    store = new TraceStore(memory.dir),
    config = ConfigSchema.parse({ maxTokens: 5000 });
  const messages = [
    { role: 'system' as const, content: 'Instructions' },
    { role: 'user' as const, content: 'Task' },
    {
      role: 'assistant' as const,
      content: JSON.stringify({ content: 'code '.repeat(5000) }),
    },
  ];
  const context = () => ({ runId: 'recovery', taskId: 'T1' });
  const request = {
    role: 'worker' as const,
    model: 'live-fake',
    callId: 'pending',
    ...workerPrompt(messages, config),
  };
  try {
    const prior = new TracedProvider(
      {
        complete: async () => ({
          content: 'done',
          toolCalls: [],
          usage: { tokens: 40, cost: 0.01 },
        }),
      },
      store,
      context,
    );
    await prior.complete(request);
    let calls = 0;
    const restored = new TracedProvider(
      {
        complete: async () => {
          calls++;
          throw new Error('Must not send a paid request again');
        },
      },
      store,
      context,
    );
    const usage = { tokens: 4990, cost: 0 };
    const budget = new BudgetProvider(restored, config, usage);
    const raw = {
      ...request,
      ...workerPrompt(
        messages,
        ConfigSchema.parse({ context: { enabled: false } }),
      ),
    };
    await expect(budget.complete(raw)).resolves.toMatchObject({
      content: 'done',
    });
    expect(calls).toBe(0);
    expect(usage).toEqual({ tokens: 5030, cost: 0.01 });
    await expect(budget.complete({ ...raw, callId: 'new' })).rejects.toThrow(
      'cap',
    );
    await expect(
      budget.complete({
        ...raw,
        canonicalMessages: [{ role: 'user', content: 'different' }],
      }),
    ).rejects.toThrow('does not match');
    expect(usage).toEqual({ tokens: 5030, cost: 0.01 });
    expect(store.events('T1').filter((e) => e.kind === 'llm')).toHaveLength(1);
  } finally {
    store.close();
  }
});

test('compacted requests can recover a response recorded before context compaction existed', async () => {
  const { TracedProvider, TraceStore } = await import('../src/trace.js');
  const memory = new Memory(fixture()),
    store = new TraceStore(memory.dir);
  const messages = [
    { role: 'system' as const, content: 'Instructions' },
    { role: 'user' as const, content: 'Task' },
    {
      role: 'assistant' as const,
      content: JSON.stringify({ content: 'code '.repeat(5000) }),
    },
  ];
  let calls = 0;
  const provider = new TracedProvider(
    {
      complete: async () => {
        calls++;
        return {
          content: 'done',
          toolCalls: [],
          usage: { tokens: 40, cost: 0.01 },
        };
      },
    },
    store,
    () => ({ runId: 'legacy', taskId: 'T1' }),
  );
  const request = {
    role: 'worker' as const,
    model: 'live-fake',
    callId: 'pending',
    messages,
  };
  try {
    await provider.complete(request);
    await expect(
      provider.complete({
        ...request,
        ...workerPrompt(messages, defaultConfig()),
      }),
    ).resolves.toMatchObject({ content: 'done' });
    expect(calls).toBe(1);
  } finally {
    store.close();
  }
});
