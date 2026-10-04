#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ConfigSchema, allTasks } from './schema.js';
import { Memory } from './memory.js';
import { createProvider } from './provider-factory.js';
import { generatePlan } from './planning.js';
import { economyProfile, SelectionSchema } from './profiles.js';
import { runAutomatically } from './autonomy.js';
import { CLIProvider } from './cli-provider.js';
import { answer } from './questions.js';
import { ParallelCoordinator } from './parallel.js';
import { Orchestrator } from './orchestrator.js';
import { TraceStore, report } from './trace.js';
export async function main(argv = process.argv.slice(2), root = process.cwd()) {
  const [command, ...args] = argv;
  if (!command || command === '--help') {
    console.log(
      'relay init [--profile economy --provider codex-cli|claude-cli|hybrid] | profile economy --provider NAME | doctor | plan | auto [--max-tasks N] [--parallel N] | run [--max-tasks N] [--parallel N] | resume [--max-tasks N] | status | trace <taskId> | report | answer <taskId> <text>',
    );
    return;
  }
  const memory = new Memory(root);
  if (command === 'init' || command === 'profile') {
    let selection: import('./profiles.js').Selection = 'codex-cli',
      economy = command === 'profile';
    const options = command === 'profile' ? args.slice(1) : args;
    if (command === 'profile' && args[0] !== 'economy')
      throw new Error('Expected profile economy --provider NAME');
    for (let i = 0; i < options.length; i += 2) {
      if (options[i] === '--profile' && options[i + 1] === 'economy')
        economy = true;
      else if (options[i] === '--provider')
        selection = SelectionSchema.parse(options[i + 1]);
      else
        throw new Error(
          'Expected --profile economy --provider codex-cli|claude-cli|hybrid',
        );
    }
    if (options.includes('--provider') && !economy)
      throw new Error('--provider requires --profile economy');
    if (command === 'profile') {
      const { RunLock } = await import('./lock.js');
      const release = new RunLock(memory.dir).acquire();
      try {
        if (memory.checkpoint()?.taskId || memory.read('parallel.json'))
          throw new Error('Stop active work before changing the profile.');
        memory.write(
          'config.json',
          JSON.stringify(
            economyProfile(
              selection,
              ConfigSchema.parse(
                JSON.parse(memory.read('config.json') || '{}'),
              ),
            ),
            null,
            2,
          ),
        );
        console.log('Economy profile saved; existing tighter caps preserved.');
        return;
      } finally {
        release();
      }
    }
    if (!memory.read('config.json'))
      memory.write(
        'config.json',
        JSON.stringify(
          economy ? economyProfile(selection) : ConfigSchema.parse({}),
          null,
          2,
        ),
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
      `${plan.objective}\n${allTasks(plan).filter((t) => t.status === 'done').length}/${allTasks(plan).length} done\nTokens: ${cp?.usage.tokens ?? 0}; estimated API spend: $${(cp?.usage.cost ?? 0).toFixed(4)}\n${memory.read('STATE.md')}`,
    );
    return;
  }
  if (!['plan', 'run', 'resume', 'auto', 'doctor'].includes(command))
    throw new Error(`Unknown command: ${command}`);
  const config = ConfigSchema.parse(
    JSON.parse(memory.read('config.json') || '{}'),
  );
  if (command === 'doctor') {
    const names = new Set([
      config.roleProviders.planner ?? config.provider,
      config.roleProviders.worker ?? config.provider,
      config.roleProviders.verifier ?? config.provider,
    ]);
    for (const name of names) {
      if (name === 'codex-cli' || name === 'claude-cli') {
        const provider = new CLIProvider(
          name === 'codex-cli' ? 'codex' : 'claude',
          config,
        );
        try {
          await provider.probe();
          console.log(
            JSON.stringify({
              provider: name,
              ready: true,
              billing: 'subscription',
              scope: 'installation and authentication only',
            }),
          );
        } catch (error) {
          console.log(
            JSON.stringify({
              provider: name,
              ready: false,
              reason: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      } else
        console.log(
          JSON.stringify({
            provider: name,
            ready:
              name === 'mock' ||
              !!process.env[
                name === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'
              ],
            billing: name === 'mock' ? 'mock' : 'api',
          }),
        );
    }
    return;
  }
  const provider = createProvider(config, memory);
  if (command === 'plan') {
    await generatePlan(memory, config, provider);
    console.log('Plan saved.');
    return;
  }
  if (command === 'auto' && !memory.read('plan.json')) {
    const saved = memory.checkpoint()?.snapshotPlan;
    if (saved) memory.savePlan(saved);
    else await generatePlan(memory, config, provider);
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
  const batch = (limit: number) =>
    width > 1 || existingParallel
      ? new ParallelCoordinator(root, config, (task) =>
          createProvider(config, memory, task.id),
        ).run(width, limit)
      : new Orchestrator(root, config, provider).run(limit);
  console.log(
    JSON.stringify(
      command === 'auto'
        ? await runAutomatically(memory, config, batch, max)
        : await batch(max),
    ),
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
