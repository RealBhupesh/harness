import { z } from 'zod';
import { CLIProvider } from './cli-provider.js';
import {
  MockProvider,
  ResponseSchema,
  type LLMProvider,
  type Role,
} from './provider.js';
import { OpenAIProvider, AnthropicProvider } from './providers.js';
import type { Config } from './schema.js';
import type { Memory } from './memory.js';
export function createProvider(
  config: Config,
  memory: Memory,
  taskId?: string,
): LLMProvider {
  const names = {
    planner: config.roleProviders.planner ?? config.provider,
    worker: config.roleProviders.worker ?? config.provider,
    verifier: config.roleProviders.verifier ?? config.provider,
  };
  const cache = new Map<string, LLMProvider>();
  const get = (name: Config['provider']): LLMProvider => {
    const found = cache.get(name);
    if (found) return found;
    const provider =
      name === 'mock'
        ? new MockProvider(
            z
              .array(ResponseSchema)
              .parse(
                JSON.parse(
                  (taskId ? memory.read(`mock-${taskId}.json`) : '') ||
                    memory.read('mock.json') ||
                    '[]',
                ),
              ),
          )
        : name === 'openai'
          ? new OpenAIProvider(process.env.OPENAI_API_KEY ?? '', config)
          : name === 'anthropic'
            ? new AnthropicProvider(process.env.ANTHROPIC_API_KEY ?? '', config)
            : new CLIProvider(
                name === 'codex-cli' ? 'codex' : 'claude',
                config,
              );
    cache.set(name, provider);
    return provider;
  };
  if (new Set(Object.values(names)).size === 1) return get(names.worker);
  if (Object.values(names).includes('mock'))
    throw new Error(
      'Mixed role routing must configure every role with a real provider; mock cursors require a single mock provider.',
    );
  return {
    billingFor: (role: Role) => get(names[role]).billingFor?.(role) ?? 'api',
    complete: (request) => get(names[request.role]).complete(request),
  };
}
