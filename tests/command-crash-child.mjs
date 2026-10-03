import { ToolRunner } from '../src/tools.ts';
import { defaultConfig } from '../src/schema.ts';
console.log(
  JSON.stringify(
    await new ToolRunner(process.argv[2], {
      ...defaultConfig(),
      commandTimeoutMs: 1000,
    }).command(['node', '--test', 'runaway.test.mjs']),
  ),
);
