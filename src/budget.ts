import type { Config } from './schema.js';
import {
  MockProvider,
  type LLMProvider,
  type Request,
  type Response,
} from './provider.js';
import { toolDefinitions } from './providers.js';
export class BudgetExceeded extends Error {}
export class BudgetProvider implements LLMProvider {
  constructor(
    readonly inner: LLMProvider,
    readonly config: Config,
    readonly usage: { tokens: number; cost: number },
  ) {}
  async complete(request: Request): Promise<Response> {
    if (
      this.usage.tokens >= this.config.maxTokens ||
      this.usage.cost >= this.config.maxCost
    )
      throw new BudgetExceeded(
        'Token or cost cap reached; increase the configured cap to continue.',
      );
    let output = this.config.maxOutputTokens;
    if (!(this.inner instanceof MockProvider)) {
      // UTF-8 byte count conservatively reserves input; remote billing may differ.
      const input =
        Buffer.byteLength(JSON.stringify(request.messages)) +
        Buffer.byteLength(JSON.stringify(toolDefinitions)) +
        1024;
      output = Math.min(
        output,
        this.config.maxTokens - this.usage.tokens - input,
      );
      const prices = this.config.prices[request.role];
      if (
        output < 1 ||
        this.usage.cost +
          (input * prices.input + output * prices.output) / 1000000 >
          this.config.maxCost
      )
        throw new BudgetExceeded(
          'Insufficient token or cost budget for another request.',
        );
    }
    const response = await this.inner.complete({
      ...request,
      maxOutputTokens: output,
    });
    this.usage.tokens += response.usage.tokens;
    this.usage.cost += response.usage.cost;
    return response;
  }
}
