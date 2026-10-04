import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { BudgetExceeded } from './budget.js';
import { runCLI, type CLIResult } from './cli-process.js';
import { toolDefinitions } from './providers.js';
import { ToolCallSchema, type Config } from './schema.js';
import {
  ResponseSchema,
  type LLMProvider,
  type Request,
  type Response,
} from './provider.js';
const Decision = z.object({
  content: z.string(),
  toolCalls: z.array(
    z.object({ name: ToolCallSchema.shape.name, argsJson: z.string() }),
  ),
});
const Count = z.number().int().nonnegative();
const Usage = z.object({
  input_tokens: Count,
  output_tokens: Count,
  cache_read_input_tokens: Count.optional(),
  cache_creation_input_tokens: Count.optional(),
});
export class ProviderPaused extends BudgetExceeded {}
export class CLIProvider implements LLMProvider {
  constructor(
    readonly kind: 'codex' | 'claude',
    readonly config: Config,
  ) {}
  billingFor() {
    return 'subscription' as const;
  }
  private paused(reason: string): never {
    throw new ProviderPaused(`${this.kind} subscription paused: ${reason}`);
  }
  private check(result: CLIResult) {
    if (result.truncated)
      this.paused('CLI output exceeded the configured byte limit.');
    if (result.code === 124 || result.code === 143)
      this.paused('CLI timeout or abort; resume when ready.');
    if (result.code !== 0) {
      const text = result.stdout + '\n' + result.stderr;
      if (/rate.?limit|usage limit|quota|limit reached/i.test(text))
        this.paused(
          'account quota or rate limit reached; resume after the account resets.',
        );
      this.paused(
        'CLI failed. Check installation, subscription login and compatible CLI options.',
      );
    }
  }
  async probe(signal?: AbortSignal): Promise<void> {
    const command = this.config.cli[this.kind],
      dir = mkdtempSync(join(tmpdir(), 'relay-auth-'));
    try {
      const args =
        this.kind === 'codex'
          ? ['login', 'status']
          : ['auth', 'status', '--json'];
      const result = await runCLI(
        [command.command, ...command.args, ...args],
        dir,
        '',
        Math.min(this.config.cli.timeoutMs, 10000),
        16000,
        signal,
      );
      this.check(result);
      if (this.kind === 'codex') {
        if (
          !/Logged in using ChatGPT/i.test(result.stdout + '\n' + result.stderr)
        )
          this.paused(
            'log in to Codex using your ChatGPT subscription; API-key authentication is refused.',
          );
      } else {
        const auth = z
          .object({ loggedIn: z.boolean(), authMethod: z.string() })
          .parse(JSON.parse(result.stdout));
        if (
          !auth.loggedIn ||
          !['claude.ai', 'oauth_token'].includes(auth.authMethod)
        )
          this.paused(
            'log in to Claude Code using subscription OAuth; API-key authentication is refused.',
          );
      }
    } catch (error) {
      if (error instanceof ProviderPaused) throw error;
      this.paused(
        'subscription authentication could not be verified; check CLI login.',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  async complete(request: Request): Promise<Response> {
    // Recheck auth each call: changing local auth must never switch to API billing.
    await this.probe(request.signal);
    const dir = mkdtempSync(join(tmpdir(), 'relay-decision-')),
      command = this.config.cli[this.kind];
    let consumption: Response['usage'] | undefined;
    try {
      const schema = JSON.stringify(Decision.toJSONSchema()),
        schemaPath = join(dir, 'schema.json'),
        outputPath = join(dir, 'response.json');
      writeFileSync(schemaPath, schema, { mode: 0o600 });
      const model =
        request.model === 'default' ? [] : ['--model', request.model];
      const args =
        this.kind === 'codex'
          ? [
              'exec',
              '--ignore-user-config',
              '--ignore-rules',
              '--ephemeral',
              '--skip-git-repo-check',
              '--sandbox',
              'read-only',
              '--json',
              '--color',
              'never',
              '--output-schema',
              schemaPath,
              '--output-last-message',
              outputPath,
              '--cd',
              dir,
              '-c',
              `sqlite_home=${JSON.stringify(join(dir, 'state'))}`,
              '-c',
              `log_dir=${JSON.stringify(join(dir, 'logs'))}`,
              '-c',
              'features.shell_tool=false',
              '-c',
              'features.apply_patch_freeform=false',
              '-c',
              'features.js_repl=false',
              '-c',
              'web_search="disabled"',
              '-c',
              `model_reasoning_effort="${this.config.cli.effort[request.role]}"`,
              ...model,
              '-',
            ]
          : [
              '--print',
              '--output-format',
              'json',
              '--json-schema',
              schema,
              '--tools',
              '',
              '--disable-slash-commands',
              '--safe-mode',
              '--no-session-persistence',
              '--strict-mcp-config',
              '--mcp-config',
              '{"mcpServers":{}}',
              '--setting-sources',
              '',
              ...model,
            ];
      const input = JSON.stringify({
        instructions:
          'You are a stateless Relay decision provider. Do not use native tools. Return the structured content/toolCalls response. Tool arguments are JSON strings in argsJson; Relay executes them independently. Batch related independent operations, use targeted patch instead of repeating whole files, and keep the response concise. For planner/verifier, put the requested JSON document as a string in content and return toolCalls:[].',
        outputTokenTarget: request.maxOutputTokens,
        messages: request.messages,
        ...(request.role === 'worker' ? { tools: toolDefinitions } : {}),
      });
      const result = await runCLI(
        [command.command, ...command.args, ...args],
        dir,
        input,
        this.config.cli.timeoutMs,
        this.config.cli.maxResponseBytes,
        request.signal,
      );
      consumption = this.reportedUsage(result.stdout);
      this.check(result);
      let decision: unknown,
        tokens = 0,
        apiEquivalentCost: number | undefined;
      if (this.kind === 'codex') {
        const events = result.stdout
          .split('\n')
          .filter((s) => s.trim())
          .map((s) => JSON.parse(s) as unknown);
        const completions = events
          .map((e) =>
            z
              .object({ type: z.string(), usage: Usage.optional() })
              .passthrough()
              .parse(e),
          )
          .filter((e) => e.type === 'turn.completed');
        if (!completions.length || completions.some((e) => !e.usage))
          this.paused('CLI reported no valid token usage.');
        for (const event of completions)
          tokens += event.usage!.input_tokens + event.usage!.output_tokens;
        if (statSync(outputPath).size > this.config.cli.maxResponseBytes)
          this.paused('structured response exceeded the byte limit.');
        decision = JSON.parse(readFileSync(outputPath, 'utf8'));
      } else {
        const envelope = z
          .object({
            is_error: z.boolean(),
            structured_output: z.unknown().optional(),
            result: z.string().optional(),
            usage: Usage.optional(),
            total_cost_usd: z.number().nonnegative().optional(),
          })
          .parse(JSON.parse(result.stdout));
        if (envelope.is_error)
          this.paused(
            'CLI rejected the request; check account limits and authentication.',
          );
        if (!envelope.usage) this.paused('CLI reported no valid token usage.');
        tokens =
          envelope.usage.input_tokens +
          envelope.usage.output_tokens +
          (envelope.usage.cache_read_input_tokens ?? 0) +
          (envelope.usage.cache_creation_input_tokens ?? 0);
        apiEquivalentCost = envelope.total_cost_usd;
        decision =
          envelope.structured_output ?? JSON.parse(envelope.result ?? '');
      }
      const parsed = Decision.parse(decision);
      return ResponseSchema.parse({
        content: parsed.content,
        toolCalls: parsed.toolCalls.map((call) => ({
          name: call.name,
          args: JSON.parse(call.argsJson),
        })),
        usage: {
          tokens,
          cost: 0,
          billing: 'subscription',
          ...(apiEquivalentCost !== undefined ? { apiEquivalentCost } : {}),
        },
      });
    } catch (error) {
      if (error instanceof ProviderPaused)
        throw new ProviderPaused(error.message, consumption);
      throw new ProviderPaused(
        `${this.kind} subscription paused: invalid structured response, arguments or token usage from the CLI protocol.`,
        consumption,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  private reportedUsage(stdout: string): Response['usage'] | undefined {
    let tokens = 0,
      found = false,
      apiEquivalentCost: number | undefined;
    for (const line of this.kind === 'codex' ? stdout.split('\n') : [stdout]) {
      try {
        const value = JSON.parse(line) as {
          type?: string;
          usage?: unknown;
          total_cost_usd?: unknown;
        };
        if (
          this.kind === 'codex' &&
          !['turn.completed', 'turn.failed'].includes(value.type ?? '')
        )
          continue;
        const usage = Usage.safeParse(value.usage);
        if (!usage.success) continue;
        found = true;
        tokens += usage.data.input_tokens + usage.data.output_tokens;
        if (this.kind === 'claude') {
          tokens +=
            (usage.data.cache_read_input_tokens ?? 0) +
            (usage.data.cache_creation_input_tokens ?? 0);
          const cost = z.number().nonnegative().safeParse(value.total_cost_usd);
          if (cost.success) apiEquivalentCost = cost.data;
        }
      } catch {
        /* Only native, validated usage is chargeable. */
      }
    }
    return found
      ? {
          tokens,
          cost: 0,
          billing: 'subscription',
          ...(apiEquivalentCost !== undefined ? { apiEquivalentCost } : {}),
        }
      : undefined;
  }
}
