import { afterEach, expect, test, vi } from 'vitest';
import { OpenAIProvider, AnthropicProvider } from '../src/providers.js';
import { BudgetProvider, BudgetExceeded } from '../src/budget.js';
import { defaultConfig } from '../src/schema.js';
import { MockProvider } from '../src/provider.js';
afterEach(() => vi.unstubAllGlobals());
const request = {
  role: 'worker' as const,
  model: 'test-model',
  messages: [{ role: 'user' as const, content: 'Write a greeting' }],
};
test('OpenAI adapter validates native tool calls and prices usage', async () => {
  let payload: Record<string, unknown> = {};
  vi.stubGlobal('fetch', async (_url: unknown, options: RequestInit) => {
    payload = JSON.parse(String(options.body));
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  function: {
                    name: 'write',
                    arguments: JSON.stringify({
                      path: 'hello.txt',
                      content: 'hi',
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
  });
  const result = await new OpenAIProvider('test-key', defaultConfig()).complete(
    request,
  );
  expect(result.toolCalls[0]).toEqual({
    name: 'write',
    args: { path: 'hello.txt', content: 'hi' },
  });
  expect(result.usage.tokens).toBe(15);
  expect(result.usage.cost).toBeGreaterThan(0);
  expect(payload.model).toBe('test-model');
  expect(payload.tools).toBeDefined();
});
test('Anthropic adapter retries transient failures and decodes tool use', async () => {
  let calls = 0;
  vi.stubGlobal('fetch', async () => {
    calls++;
    if (calls === 1) return new Response('rate limited', { status: 429 });
    return new Response(
      JSON.stringify({
        content: [
          { type: 'text', text: 'Working' },
          { type: 'tool_use', name: 'read', input: { path: 'hello.txt' } },
        ],
        usage: { input_tokens: 12, output_tokens: 3 },
      }),
    );
  });
  const result = await new AnthropicProvider(
    'test-key',
    defaultConfig(),
  ).complete(request);
  expect(calls).toBe(2);
  expect(result.content).toBe('Working');
  expect(result.toolCalls[0]?.name).toBe('read');
  expect(result.usage.tokens).toBe(15);
});
test('nonretryable authentication errors stop after one request', async () => {
  let calls = 0;
  vi.stubGlobal('fetch', async () => {
    calls++;
    return new Response('denied', { status: 401 });
  });
  await expect(
    new OpenAIProvider('test-key', defaultConfig()).complete(request),
  ).rejects.toThrow('401');
  expect(calls).toBe(1);
});
test('meter stops at cap and does not silently discard usage', async () => {
  const usage = { tokens: 0, cost: 0 };
  const wrapped = new BudgetProvider(
    new MockProvider([{ content: 'done', usage: { tokens: 10, cost: 2 } }]),
    { ...defaultConfig(), maxCost: 1 },
    usage,
  );
  await expect(wrapped.complete(request)).rejects.toBeInstanceOf(
    BudgetExceeded,
  );
  expect(usage.cost).toBe(2);
  expect(usage.tokens).toBe(10);
});
test('provider responds to an already-aborted task signal without retrying', async () => {
  let calls = 0;
  vi.stubGlobal('fetch', async (_url: unknown, options: RequestInit) => {
    calls++;
    if (options.signal?.aborted) throw options.signal.reason;
    return new Response('{}');
  });
  await expect(
    new OpenAIProvider('test-key', defaultConfig()).complete({
      ...request,
      signal: AbortSignal.abort(new Error('cancelled')),
    }),
  ).rejects.toThrow('cancelled');
  expect(calls).toBe(1);
});
