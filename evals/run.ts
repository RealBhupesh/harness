import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  ConfigSchema,
  PlanSchema,
  allTasks,
  type Config,
} from '../src/schema.js';
import { MockProvider, type LLMProvider } from '../src/provider.js';
import { OpenAIProvider, AnthropicProvider } from '../src/providers.js';
import { Memory } from '../src/memory.js';
import { Orchestrator } from '../src/orchestrator.js';
import { benchmarks, type Benchmark } from './fixtures.js';
export type Score = {
  failure: string | null;
  task: string;
  done: boolean;
  oracle: boolean;
  success: boolean;
  attempts: number;
  tokens: number;
  cost: number;
};
async function evaluate(
  benchmark: Benchmark,
  config: Config,
  guard = false,
): Promise<Score> {
  const base = mkdtempSync(join(tmpdir(), 'relay-eval-')),
    root = join(base, 'repo');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  try {
    execFileSync('git', ['init', '-b', 'main', root], { stdio: 'pipe' });
    git('config', 'user.email', 'relay-eval@example.test');
    git('config', 'user.name', 'Relay Eval');
    writeFileSync(join(root, '.gitignore'), '.relay/\n');
    writeFileSync(join(root, 'GOAL.md'), benchmark.goal);
    writeFileSync(join(root, 'math.mjs'), benchmark.initial);
    writeFileSync(join(root, 'acceptance.test.mjs'), benchmark.tests);
    git('add', '.');
    git('commit', '-m', 'chore: evaluation fixture');
    const memory = new Memory(root);
    const plan = PlanSchema.parse({
      objective: benchmark.goal,
      milestones: [
        {
          id: 'M1',
          title: benchmark.id,
          tasks: [
            {
              id: 'T1',
              title: benchmark.id,
              description: benchmark.goal,
              acceptance: [
                {
                  id: 'A1',
                  description: 'Existing tests pass',
                  kind: 'command',
                  argv: ['node', '--test', 'acceptance.test.mjs'],
                },
                ...(benchmark.refactor
                  ? [
                      {
                        id: 'A2',
                        description: 'Uses reduce',
                        kind: 'fileContains',
                        path: 'math.mjs',
                        text: '.reduce(',
                      },
                    ]
                  : []),
              ],
              dependencies: [],
              size: 'S',
              status: 'todo',
              attempts: 0,
              priority: 1,
            },
          ],
        },
      ],
    });
    memory.savePlan(plan);
    let provider: LLMProvider;
    if (guard || config.provider === 'mock') {
      const implement = (
        content: string,
      ): ConstructorParameters<typeof MockProvider>[0] => [
        {
          content: '',
          toolCalls: [{ name: 'write', args: { path: 'math.mjs', content } }],
          usage: { tokens: 50, cost: 0 },
        },
        { content: 'Implementation complete', usage: { tokens: 20, cost: 0 } },
      ];
      provider = new MockProvider(
        guard
          ? [{ content: 'All done; tests passed' }]
          : [
              ...(benchmark.retry ? implement(benchmark.retry) : []),
              ...implement(benchmark.solution),
              {
                content: JSON.stringify({
                  criteria: allTasks(plan)[0]!.acceptance.map((c) => ({
                    id: c.id,
                    passed: true,
                    evidence:
                      'Executed acceptance checks passed and patch reviewed',
                  })),
                  summary: 'Verified',
                }),
                usage: { tokens: 50, cost: 0 },
              },
            ],
      );
    } else
      provider =
        config.provider === 'openai'
          ? new OpenAIProvider(process.env.OPENAI_API_KEY ?? '', config)
          : new AnthropicProvider(process.env.ANTHROPIC_API_KEY ?? '', config);
    await new Orchestrator(
      root,
      {
        ...config,
        maxAttempts: guard ? 1 : config.maxAttempts,
        maxTasks: Math.min(config.maxTasks, 3),
        verificationCommands: [
          ['node', '--check', 'math.mjs'],
          ['node', '--test', 'acceptance.test.mjs'],
        ],
      },
      provider,
    ).run(3);
    // The scoring oracle lives outside the worker checkout, so editing its tests cannot improve the score.
    const oracle = join(base, 'oracle.mjs');
    writeFileSync(
      oracle,
      `import assert from 'node:assert/strict';import * as module from ${JSON.stringify(pathToFileURL(join(root, 'math.mjs')).href)};${benchmark.oracle}`,
    );
    const checked = spawnSync(process.execPath, [oracle], {
      cwd: root,
      timeout: 5000,
      encoding: 'utf8',
    });
    const task = allTasks(memory.loadPlan())[0]!,
      usage = memory.checkpoint()!.usage;
    return {
      failure: task.notes.join('\n') || null,
      task: guard ? 'false-success-guard' : benchmark.id,
      done: task.status === 'done',
      oracle: checked.status === 0,
      success: task.status === 'done' && checked.status === 0,
      attempts: task.attempts,
      ...usage,
    };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
export async function scorecard(config = ConfigSchema.parse({})) {
  const rows: Score[] = [];
  for (const benchmark of benchmarks)
    rows.push(await evaluate(benchmark, config));
  const guard = await evaluate(benchmarks[1]!, ConfigSchema.parse({}), true);
  const approved = [...rows, guard].filter((r) => r.done);
  return {
    provider: config.provider,
    rows,
    guard,
    successRate: rows.filter((r) => r.success).length / rows.length,
    attemptsPerTask: rows.reduce((n, r) => n + r.attempts, 0) / rows.length,
    verificationFalsePositiveRate: approved.length
      ? approved.filter((r) => !r.oracle).length / approved.length
      : null,
    costPerTask: rows.reduce((n, r) => n + r.cost, 0) / rows.length,
  };
}
async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.some((arg) => arg !== '--live'))
    throw new Error('Usage: pnpm eval [--live]');
  const config = args.includes('--live')
    ? ConfigSchema.parse(JSON.parse(process.env.RELAY_EVAL_CONFIG ?? '{}'))
    : ConfigSchema.parse({});
  if (args.includes('--live') && config.provider === 'mock')
    throw new Error(
      '--live requires RELAY_EVAL_CONFIG with a real provider, models, prices and budgets',
    );
  const result = await scorecard(config);
  console.log(
    `Relay ${result.provider} evaluation (isolated Git fixtures; independent scoring oracle)`,
  );
  console.table(
    result.rows.map((r) => ({
      task: r.task,
      success: r.success,
      attempts: r.attempts,
      tokens: r.tokens,
      cost: r.cost,
    })),
  );
  console.log(JSON.stringify(result, null, 2));
  if (result.guard.done)
    throw new Error('False-success guard was incorrectly approved');
  if (config.provider === 'mock' && result.successRate !== 1)
    throw new Error('Offline evaluation regression');
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
