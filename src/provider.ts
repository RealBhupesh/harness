import { z } from 'zod';
import { ToolCallSchema, type ToolCall } from './schema.js';
export type Message = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};
export type Role = 'planner' | 'worker' | 'verifier';
export type Request = {
  role: Role;
  model: string;
  messages: Message[];
  signal?: AbortSignal;
  maxOutputTokens?: number;
  callId?: string;
  artifactHash?: string;
  // In-process durable dialogue reference; adapters send only messages.
  canonicalMessages?: Message[];
  promptStats?: {
    originalBytes: number;
    sentBytes: number;
    omittedMessages: number;
  };
};
export const ResponseSchema = z.object({
  content: z.string(),
  toolCalls: z.array(ToolCallSchema).default([]),
  usage: z
    .object({
      tokens: z.number().int().nonnegative(),
      cost: z.number().nonnegative(),
    })
    .default({ tokens: 0, cost: 0 }),
});
export type Response = z.infer<typeof ResponseSchema>;
export interface LLMProvider {
  readonly mock?: boolean;
  // Recover an already-paid durable response without making a new request.
  recover?(request: Request): Response | undefined;
  complete(request: Request): Promise<Response>;
}
export class MockProvider implements LLMProvider {
  readonly mock = true;
  private cursor = 0;
  get position() {
    return this.cursor;
  }
  set position(value: number) {
    this.cursor = value;
  }
  constructor(
    private readonly responses: {
      content: string;
      toolCalls?: ToolCall[];
      usage?: Response['usage'];
    }[],
  ) {}
  async complete(request: Request): Promise<Response> {
    void request;
    const response = this.responses[this.cursor++];
    if (!response) throw new Error('MockProvider script exhausted');
    return ResponseSchema.parse(response);
  }
}
