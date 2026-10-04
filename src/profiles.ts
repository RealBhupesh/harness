import { z } from 'zod';
import { ConfigSchema, type Config } from './schema.js';
export const SelectionSchema = z.enum([
  'codex-cli',
  'claude-cli',
  'hybrid',
  'mock',
]);
export type Selection = z.infer<typeof SelectionSchema>;
export function economyProfile(
  selection: Selection,
  existing?: Config,
): Config {
  const base = existing ?? ConfigSchema.parse({ maxTasks: 50 });
  const provider = selection === 'hybrid' ? 'codex-cli' : selection;
  const models =
    selection === 'mock'
      ? { planner: 'mock', worker: 'mock', verifier: 'mock' }
      : selection === 'claude-cli'
        ? { planner: 'haiku', worker: 'sonnet', verifier: 'sonnet' }
        : selection === 'hybrid'
          ? { planner: 'haiku', worker: 'default', verifier: 'sonnet' }
          : { planner: 'default', worker: 'default', verifier: 'default' };
  return ConfigSchema.parse({
    ...base,
    provider,
    models,
    parallel: 1,
    roleProviders:
      selection === 'hybrid'
        ? { planner: 'claude-cli', worker: 'codex-cli', verifier: 'claude-cli' }
        : {},
    context: {
      ...base.context,
      enabled: true,
      maxPromptBytes: Math.min(base.context.maxPromptBytes, 24000),
      maxEntryBytes: Math.min(base.context.maxEntryBytes, 1200),
      maxEvidenceBytes: Math.min(base.context.maxEvidenceBytes, 700),
    },
    roleOutputTokens: {
      planner: Math.min(base.roleOutputTokens.planner, 2048),
      worker: Math.min(base.roleOutputTokens.worker, 1536),
      verifier: Math.min(base.roleOutputTokens.verifier, 1024),
    },
    cli: {
      ...base.cli,
      effort: { planner: 'medium', worker: 'low', verifier: 'medium' },
    },
  });
}
