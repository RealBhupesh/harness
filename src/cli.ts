#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ConfigSchema, PlanSchema, allTasks } from './schema.js';
import { Memory } from './memory.js';
import { MockProvider, ResponseSchema } from './provider.js';
import { Orchestrator } from './orchestrator.js';
export async function main(argv = process.argv.slice(2), root = process.cwd()) {
  const [command, ...args] = argv;
  const memory = new Memory(root);
  if (!command || command === '--help') {
    console.log('relay init | plan | run [--max-tasks N] | resume | status');
    return;
  }
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
    console.log('Initialized .relay/; configure provider and supply GOAL.md.');
    return;
  }
  const config = ConfigSchema.parse(
    JSON.parse(memory.read('config.json') || '{}'),
  );
  if (command === 'status') {
    const plan = memory.loadPlan();
    console.log(
      `${plan.objective}\n${allTasks(plan).filter((t) => t.status === 'done').length}/${allTasks(plan).length} done\n${memory.read('STATE.md')}`,
    );
    return;
  }
  if (config.provider !== 'mock')
    throw new Error('Real provider adapters are not implemented yet.');
  const script = z
    .array(ResponseSchema)
    .parse(JSON.parse(memory.read('mock.json') || '[]'));
  const provider = new MockProvider(script);
  if (command === 'plan') {
    const goal = readFileSync(join(root, 'GOAL.md'), 'utf8');
    if (goal.includes('<<YOUR GOAL HERE'))
      throw new Error('Replace the GOAL.md placeholder with a real objective.');
    const response = await provider.complete({
      role: 'planner',
      model: config.models.planner,
      messages: [
        {
          role: 'user',
          content: `Return plan JSON matching ${JSON.stringify(PlanSchema.toJSONSchema())}. Goal: ${goal}`,
        },
      ],
    });
    const plan = PlanSchema.parse(JSON.parse(response.content));
    memory.savePlan(plan);
    console.log('Plan saved.');
    return;
  }
  if (command === 'run' || command === 'resume') {
    let max = config.maxTasks;
    if (args.length) {
      if (args.length !== 2 || args[0] !== '--max-tasks')
        throw new Error('Expected --max-tasks N');
      max = z.coerce.number().int().positive().parse(args[1]);
    }
    console.log(
      JSON.stringify(await new Orchestrator(root, config, provider).run(max)),
    );
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
