import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Memory } from '../src/memory.ts';
import { Git } from '../src/git.ts';
import { ToolRunner } from '../src/tools.ts';
import { MockProvider } from '../src/provider.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { defaultConfig } from '../src/schema.ts';
const [root, mode] = process.argv.slice(2);
const marker = join(root, '.relay/killed');
const kill = () => {
  if (!existsSync(marker)) {
    writeFileSync(marker, 'once');
    process.kill(process.pid, 'SIGKILL');
  }
};
const original = Memory.prototype.saveCheckpoint;
Memory.prototype.saveCheckpoint = function (cp) {
  original.call(this, cp);
  if (cp.phase === mode) kill();
};
const integrate = Git.prototype.integrate;
Git.prototype.integrate = function (...args) {
  integrate.apply(this, args);
  if (mode === 'merged') kill();
};
const run = ToolRunner.prototype.run;
ToolRunner.prototype.run = async function (...args) {
  const result = await run.apply(this, args);
  if (mode === 'tool' && args[0].name === 'write') kill();
  return result;
};
const script = JSON.parse(readFileSync(join(root, '.relay/mock.json'), 'utf8'));
const result = await new Orchestrator(
  root,
  defaultConfig(),
  new MockProvider(script),
).run();
console.log(JSON.stringify(result));
