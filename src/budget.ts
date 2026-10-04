import type { Config } from './schema.js';
import {
  BudgetExceeded,
  type LLMProvider,
  type Request,
  type Response,
} from './provider.js';
import { toolDefinitions } from './providers.js';
export { BudgetExceeded } from './provider.js';
export class BudgetProvider implements LLMProvider {
  constructor(
    readonly inner: LLMProvider,
    readonly config: Config,
    readonly usage: { tokens: number; cost: number },
    readonly onFailureReceipt?: (id: string) => void,
  ) {}
  async complete(request: Request): Promise<Response> {
    try {
      const recovered = this.inner.recover?.(request);
      if (recovered) {
        this.usage.tokens += recovered.usage.tokens;
        this.usage.cost += recovered.usage.cost;
        return recovered;
      }
      if (
        this.usage.tokens >= this.config.maxTokens ||
        this.usage.cost >= this.config.maxCost
      )
        throw new BudgetExceeded(
          'Token or cost cap reached; increase the configured cap to continue.',
        );
      let output = Math.min(
        this.config.maxOutputTokens,
        this.config.roleOutputTokens[request.role],
        request.maxOutputTokens ?? Infinity,
      );
      if (!this.inner.mock) {
        // UTF-8 byte count conservatively reserves input; remote billing may differ.
        const input =
          Buffer.byteLength(JSON.stringify(request.messages)) +
          (request.role === 'worker'
            ? Buffer.byteLength(JSON.stringify(toolDefinitions))
            : 0) +
          1024;
        output = Math.min(
          output,
          this.config.maxTokens - this.usage.tokens - input,
        );
        const prices = this.config.prices[request.role];
        if (
          output < 1 ||
          (this.inner.billingFor?.(request.role) !== 'subscription' &&
            this.usage.cost +
              (input * prices.input + output * prices.output) / 1000000 >
              this.config.maxCost)
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
    } catch (error) {
      if (error instanceof BudgetExceeded && error.usage) {
        this.usage.tokens += error.usage.tokens;
        this.usage.cost += error.usage.cost;
        if (error.receiptId) this.onFailureReceipt?.(error.receiptId);
      }
      throw error;
    }
  }
}
