#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ConfigSchema, PlanSchema, allTasks } from './schema.js';
import { Memory } from './memory.js';
import { MockProvider, ResponseSchema } from './provider.js';
import { OpenAIProvider, AnthropicProvider } from './providers.js';
import { BudgetProvider } from './budget.js';
import { revisePlan } from './planner.js';
import { answer } from './questions.js';
import { ParallelCoordinator } from './parallel.js';
import { Orchestrator } from './orchestrator.js';
import { TraceStore, TracedProvider, report } from './trace.js';
export async function main(argv = process.argv.slice(2), root = process.cwd()) {
  const [command, ...args] = argv;
  if (!command || command === '--help') {
    console.log(
      'relay init | plan | run [--max-tasks N] [--parallel N] | resume [--max-tasks N] | status | trace <taskId> | report | answer <taskId> <text>',
    );
    return;
  }
  const memory = new Memory(root);
  if (command === 'init') {
    if (!memory.read('config.json'))
      memory.write(
        'config.json',
        JSON.stringify(ConfigSchema.parse({}), null, 2),
      );
    for (const file of [
      'STATE.md',
      'PLAN.md',
      'LOG.md',
      'DECISIONS.md',
      'LEARNINGS.md',
      'QUESTIONS.md',
    ])
      if (!memory.read(file))
        memory.write(file, `# ${file.replace('.md', '')}\n`);
    console.log(
      'Initialized .relay/; configure provider, Git ignores and supply GOAL.md.',
    );
    return;
  }
  if (command === 'answer') {
    if (!args[0]) throw new Error('Expected task ID and answer');
    answer(memory, args[0], args.slice(1).join(' '));
    console.log('Answer saved; task is eligible for retry.');
    return;
  }
  if (command === 'trace' || command === 'report') {
    const store = new TraceStore(memory.dir);
    try {
      if (command === 'trace') {
        if (!args[0]) throw new Error('Expected task ID');
        console.log(
          store
            .events(args[0])
            .map((e) => `${e.time} ${e.kind} ${e.payload}`)
            .join('\n'),
        );
      } else {
        report(memory, store);
        console.log('Saved .relay/report.html');
      }
    } finally {
      store.close();
    }
    return;
  }
  if (command === 'status') {
    const plan = memory.loadPlan(),
      cp = memory.checkpoint();
    console.log(
      `${plan.objective}\n${allTasks(plan).filter((t) => t.status === 'done').length}/${allTasks(plan).length} done\nTokens: ${cp?.usage.tokens ?? 0}; estimated cost: $${(cp?.usage.cost ?? 0).toFixed(4)}\n${memory.read('STATE.md')}`,
    );
    return;
  }
  if (!['plan', 'run', 'resume'].includes(command))
    throw new Error(`Unknown command: ${command}`);
  const config = ConfigSchema.parse(
    JSON.parse(memory.read('config.json') || '{}'),
  );
  const provider =
    config.provider === 'mock'
      ? new MockProvider(
          z
            .array(ResponseSchema)
            .parse(JSON.parse(memory.read('mock.json') || '[]')),
        )
      : config.provider === 'openai'
        ? new OpenAIProvider(process.env.OPENAI_API_KEY ?? '', config)
        : new AnthropicProvider(process.env.ANTHROPIC_API_KEY ?? '', config);
  if (command === 'plan') {
    const goal = readFileSync(join(root, 'GOAL.md'), 'utf8');
    if (goal.includes('<<YOUR GOAL HERE') || !goal.trim())
      throw new Error('Replace the GOAL.md placeholder with a real objective.');
    const trace = new TraceStore(memory.dir);
    try {
      const planner = new TracedProvider(
        new BudgetProvider(provider, config, { tokens: 0, cost: 0 }),
        trace,
        () => ({ runId: 'planning', taskId: null }),
      );
      const response = await planner.complete({
        role: 'planner',
        model: config.models.planner,
        messages: [
          {
            role: 'system',
            content:
              'Return only valid plan JSON. Criteria must be executable and cover all task requirements. Preserve completed tasks exactly when revising.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              schema: PlanSchema.toJSONSchema(),
              goal,
              existing: memory.read('plan.json'),
            }),
          },
        ],
      });
      revisePlan(
        memory,
        PlanSchema.parse(JSON.parse(response.content)),
        'Human requested plan from current GOAL.md',
      );
      console.log('Plan saved.');
    } finally {
      trace.close();
    }
    return;
  }
  let max = config.maxTasks,
    width = config.parallel;
  const existingParallel = memory.read('parallel.json');
  if (existingParallel)
    width = z
      .object({ width: z.number().int().positive() })
      .parse(JSON.parse(existingParallel)).width;
  for (let i = 0; i < args.length; i += 2) {
    const value = z.coerce
      .number()
      .int()
      .positive()
      .parse(args[i + 1]);
    if (args[i] === '--max-tasks') max = value;
    else if (args[i] === '--parallel') width = z.number().max(8).parse(value);
    else throw new Error('Expected --max-tasks N or --parallel N');
  }
  if (width > 1 || existingParallel) {
    const factory = (task: import('./schema.js').Task) =>
      config.provider === 'mock'
        ? new MockProvider(
            z
              .array(ResponseSchema)
              .parse(
                JSON.parse(
                  memory.read(`mock-${task.id}.json`) ||
                    memory.read('mock.json') ||
                    '[]',
                ),
              ),
          )
        : config.provider === 'openai'
          ? new OpenAIProvider(process.env.OPENAI_API_KEY ?? '', config)
          : new AnthropicProvider(process.env.ANTHROPIC_API_KEY ?? '', config);
    console.log(
      JSON.stringify(
        await new ParallelCoordinator(root, config, factory).run(width, max),
      ),
    );
  } else
    console.log(
      JSON.stringify(await new Orchestrator(root, config, provider).run(max)),
    );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
