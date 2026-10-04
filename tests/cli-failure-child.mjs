import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigSchema } from '../src/schema.ts';
import { CLIProvider } from '../src/cli-provider.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { TraceStore } from '../src/trace.ts';
const root = process.argv[2];
const config = ConfigSchema.parse(
  JSON.parse(readFileSync(join(root, '.relay/config.json'), 'utf8')),
);
const record = TraceStore.prototype.record;
TraceStore.prototype.record = function (kind, payload, context) {
  const id = record.call(this, kind, payload, context);
  if (kind === 'llm_error' && payload.usage)
    process.kill(process.pid, 'SIGKILL');
  return id;
};
await new Orchestrator(root, config, new CLIProvider('codex', config)).run();
