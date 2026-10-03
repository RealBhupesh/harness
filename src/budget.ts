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
    return response;
  }
}
