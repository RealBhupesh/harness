import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ParallelCoordinator } from '../src/parallel.ts';
import { Memory } from '../src/memory.ts';
import { Git } from '../src/git.ts';
import { MockProvider } from '../src/provider.ts';
import { defaultConfig } from '../src/schema.ts';
const [root, mode, max = '2'] = process.argv.slice(2),
  memory = new Memory(root),
  marker = join(memory.dir, 'killed');
const kill = () => {
  if (!existsSync(marker)) {
    writeFileSync(marker, 'once');
    process.kill(process.pid, 'SIGKILL');
  }
};
const run = Git.prototype.run;
Git.prototype.run = function (args) {
  const result = run.call(this, args);
  if (
    this.root === root &&
    ((mode === 'merge' && args[0] === 'merge') ||
      (mode === 'rollback' && args[0] === 'revert'))
  )
    kill();
  return result;
};
const saveCheckpoint = Memory.prototype.saveCheckpoint;
Memory.prototype.saveCheckpoint = function (checkpoint) {
  saveCheckpoint.call(this, checkpoint);
  if (mode === 'spent' && this.root !== root && checkpoint.usage.cost >= 1)
    kill();
};
const write = Memory.prototype.write;
Memory.prototype.write = function (name, value) {
  write.call(this, name, value);
  if (
    this.root === root &&
    mode === 'workers' &&
    name === 'parallel.json' &&
    JSON.parse(value).entries.some((e) => e.stage === 'verified')
  )
    kill();
};
const config = {
  ...defaultConfig(),
  ...JSON.parse(memory.read('config.json') || '{}'),
  maxAttempts: 1,
};
const factory = (task) =>
  new MockProvider(JSON.parse(memory.read(`mock-${task.id}.json`)));
console.log(
  JSON.stringify(
    await new ParallelCoordinator(root, config, factory).run(2, Number(max)),
  ),
);
