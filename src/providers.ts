import { z } from 'zod';
import type { Config } from './schema.js';
import {
  ResponseSchema,
  type LLMProvider,
  type Request,
  type Response,
} from './provider.js';
export const toolDefinitions = [
  {
    name: 'read',
    description:
      'Read a repository file; use startLine and maxLines for small pages of large files',
    properties: {
      path: { type: 'string' },
      startLine: { type: 'integer', minimum: 1 },
      maxLines: { type: 'integer', minimum: 1, maximum: 1000 },
    },
    required: ['path'],
  },
  {
    name: 'write',
    description: 'Write a repository file',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  {
    name: 'patch',
    description: 'Replace exactly one text match',
    properties: {
      path: { type: 'string' },
      oldText: { type: 'string' },
      newText: { type: 'string' },
    },
    required: ['path', 'oldText', 'newText'],
  },
  {
    name: 'search',
    description: 'Search a bounded set of repository files',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
  {
    name: 'command',
    description: 'Run allowed test/typecheck/lint/build argv without shell',
    properties: { argv: { type: 'array', items: { type: 'string' } } },
    required: ['argv'],
  },
  {
    name: 'git',
    description: 'Read Git status, diff, log',
    properties: { argv: { type: 'array', items: { type: 'string' } } },
    required: ['argv'],
  },
];
const toolSchema = (tool: (typeof toolDefinitions)[number]) => ({
  type: 'object',
  properties: tool.properties,
  required: tool.required,
  additionalProperties: false,
});
async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const timeout = AbortSignal.timeout(30000),
        combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const result = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: combined,
      });
      if (result.ok) return await result.json();
      if ((result.status === 429 || result.status >= 500) && attempt < 2) {
        await result.body?.cancel();
        await delay(100 * 2 ** attempt, signal);
        continue;
      }
      throw new HttpError(`Provider request failed (${result.status})`);
    } catch (error) {
      if (error instanceof HttpError || signal?.aborted || attempt === 2)
        throw error;
      await delay(100 * 2 ** attempt, signal);
    }
  }
  throw new Error('Retry exhaustion');
}
class HttpError extends Error {}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
const Usage = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
});
function meter(
  config: Config,
  request: Request,
  input: number,
  output: number,
) {
  const counts = Usage.parse({ input, output }),
    price = config.prices[request.role];
  return {
    tokens: counts.input + counts.output,
    cost: (counts.input * price.input + counts.output * price.output) / 1000000,
  };
}
const OpenAIResponse = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable(),
          tool_calls: z
            .array(
              z.object({
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .optional(),
        }),
      }),
    )
    .min(1),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    total_tokens: z.number(),
  }),
});
export class OpenAIProvider implements LLMProvider {
  constructor(
    private readonly key: string,
    private readonly config: Config,
  ) {
    if (!key) throw new Error('OPENAI_API_KEY is required');
  }
  async complete(request: Request): Promise<Response> {
    const raw = OpenAIResponse.parse(
      await post(
        'https://api.openai.com/v1/chat/completions',
        { authorization: `Bearer ${this.key}` },
        {
          model: request.model,
          messages: request.messages,
          max_completion_tokens:
            request.maxOutputTokens ?? this.config.maxOutputTokens,
          ...(request.role === 'worker'
            ? {
                tools: toolDefinitions.map((tool) => ({
                  type: 'function',
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: toolSchema(tool),
                  },
                })),
              }
            : {}),
        },
        request.signal,
      ),
    );
    const msg = raw.choices[0]!.message;
    return ResponseSchema.parse({
      content: msg.content ?? '',
      toolCalls: (msg.tool_calls ?? []).map((t) => ({
        name: t.function.name,
        args: JSON.parse(t.function.arguments),
      })),
      usage: meter(
        this.config,
        request,
        raw.usage.prompt_tokens,
        raw.usage.completion_tokens,
      ),
    });
  }
}
const Block = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
]);
const AnthropicResponse = z.object({
  content: z.array(Block),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});
export class AnthropicProvider implements LLMProvider {
  constructor(
    private readonly key: string,
    private readonly config: Config,
  ) {
    if (!key) throw new Error('ANTHROPIC_API_KEY is required');
  }
  async complete(request: Request): Promise<Response> {
    const raw = AnthropicResponse.parse(
      await post(
        'https://api.anthropic.com/v1/messages',
        { 'x-api-key': this.key, 'anthropic-version': '2023-06-01' },
        {
          model: request.model,
          system: request.messages
            .filter((m) => m.role === 'system')
            .map((m) => m.content)
            .join('\n'),
          messages: request.messages.filter((m) => m.role !== 'system'),
          max_tokens: request.maxOutputTokens ?? this.config.maxOutputTokens,
          ...(request.role === 'worker'
            ? {
                tools: toolDefinitions.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: toolSchema(tool),
                })),
              }
            : {}),
        },
        request.signal,
      ),
    );
    return ResponseSchema.parse({
      content: raw.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
      toolCalls: raw.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ name: b.name, args: b.input })),
      usage: meter(
        this.config,
        request,
        raw.usage.input_tokens,
        raw.usage.output_tokens,
      ),
    });
  }
}
