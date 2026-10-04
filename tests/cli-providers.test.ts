import { expect, test, vi, afterEach } from 'vitest';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { ConfigSchema } from '../src/schema.js';
import type { Request } from '../src/provider.js';
afterEach(() => vi.unstubAllEnvs());
const request: Request = {
  role: 'worker',
  model: 'default',
  messages: [{ role: 'user', content: 'Write greeting' }],
  maxOutputTokens: 300,
};
function native(kind: 'codex' | 'claude', mode = 'success') {
  const root = fixture(),
    script = join(root, 'fake-cli.mjs'),
    log = join(root, 'calls.jsonl');
  writeFileSync(
    script,
    `import fs from 'node:fs';const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,api:!!process.env.ANTHROPIC_API_KEY||!!process.env.OPENAI_API_KEY,sqliteHome:process.env.CODEX_SQLITE_HOME})+'\\n');
 const mode=${JSON.stringify(mode)},kind=${JSON.stringify(kind)};
 if(args.includes('status')) {if(kind==='codex'){console.error(mode==='api'?'Logged in using an API key':'Logged in using ChatGPT');}else console.log(JSON.stringify({loggedIn:true,authMethod:mode==='api'?'api_key':'claude.ai',subscriptionType:'pro'}));process.exit(0);}
 if(mode==='hang'){setInterval(()=>{},100);}
 else {let input='';for await(const chunk of process.stdin)input+=chunk;fs.writeFileSync(${JSON.stringify(join(root, 'input.txt'))},input);
 if(mode==='quota'||mode==='quota-usage'){console.log(JSON.stringify(kind==='codex'?{type:'turn.failed',error:'Usage limit reached',usage:mode==='quota-usage'?{input_tokens:20,output_tokens:4}:undefined}:{type:'result',is_error:true,errors:['Usage limit reached'],usage:mode==='quota-usage'?{input_tokens:20,output_tokens:4}:undefined}));process.exit(1);}
 const decision={content:'working',toolCalls:[{name:'write',argsJson:JSON.stringify({path:'hello.txt',content:'Hello Relay'})}]};
 if(mode==='bad')decision.toolCalls[0].argsJson='invalid';
 if(kind==='codex'){fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(decision));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:20,cached_input_tokens:10,output_tokens:4}}));}
 else console.log(JSON.stringify({type:'result',is_error:false,structured_output:decision,usage:mode==='no-usage'?undefined:{input_tokens:20,cache_read_input_tokens:10,cache_creation_input_tokens:3,output_tokens:4},total_cost_usd:0.003}));}
 `,
  );
  const config = ConfigSchema.parse({
    provider: kind + '-cli',
    cli: {
      [kind]: { command: process.execPath, args: [script] },
      timeoutMs: 1000,
    },
  });
  return {
    root,
    config,
    calls: () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map(
          (s) =>
            JSON.parse(s) as {
              args: string[];
              api: boolean;
              sqliteHome?: string;
            },
        ),
  };
}
function ignoreArtifacts(root: string) {
  appendFileSync(
    join(root, '.gitignore'),
    'fake-cli.mjs\ncalls.jsonl\ninput.txt\n',
  );
  execFileSync('git', ['add', '.gitignore'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'ignore native test artifacts'], {
    cwd: root,
  });
}
for (const kind of ['codex', 'claude'] as const) {
  test(`${kind} subscription adapter parses native structured decisions and reported usage`, async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'must-not-be-used');
    vi.stubEnv('OPENAI_API_KEY', 'must-not-be-used');
    const f = native(kind);
    const { CLIProvider } = await import('../src/cli-provider.js');
    const provider = new CLIProvider(kind, f.config),
      result = await provider.complete(request);
    expect(result.toolCalls).toEqual([
      { name: 'write', args: { path: 'hello.txt', content: 'Hello Relay' } },
    ]);
    expect(result.usage).toMatchObject({
      tokens: kind === 'codex' ? 24 : 37,
      cost: 0,
      billing: 'subscription',
    });
    if (kind === 'claude') expect(result.usage.apiEquivalentCost).toBe(0.003);
    const calls = f.calls();
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => !c.api)).toBe(true);
    expect(readFileSync(join(f.root, 'input.txt'), 'utf8')).toContain(
      'Write greeting',
    );
    const args = calls[1]!.args;
    expect(args.some((s) => s.includes('dangerously'))).toBe(false);
    if (kind === 'codex') {
      expect(args).toContain('read-only');
      expect(args).toContain('--ignore-user-config');
      expect(calls[1]!.sqliteHome).toContain('relay-decision-');
      expect(args.some((s) => s.startsWith('sqlite_home='))).toBe(true);
    } else {
      expect(args[args.indexOf('--tools') + 1]).toBe('');
      expect(args).toContain('--safe-mode');
    }
  });
  test(`${kind} refuses API authentication before any model request`, async () => {
    const f = native(kind, 'api');
    const { CLIProvider } = await import('../src/cli-provider.js');
    await expect(
      new CLIProvider(kind, f.config).complete(request),
    ).rejects.toThrow(/subscription|ChatGPT|OAuth/i);
    expect(f.calls()).toHaveLength(1);
  });
  test(`${kind} quota limits pause instead of retrying the process`, async () => {
    const f = native(kind, 'quota');
    const { CLIProvider } = await import('../src/cli-provider.js');
    const { BudgetExceeded } = await import('../src/budget.js');
    await expect(
      new CLIProvider(kind, f.config).complete(request),
    ).rejects.toBeInstanceOf(BudgetExceeded);
    expect(f.calls()).toHaveLength(2);
  });
}
test('missing native usage fails closed instead of zero-token success', async () => {
  const f = native('claude', 'no-usage');
  const { CLIProvider } = await import('../src/cli-provider.js');
  await expect(
    new CLIProvider('claude', f.config).complete(request),
  ).rejects.toThrow(/usage/i);
});
test('malformed tool arguments never reach Relay tools', async () => {
  const f = native('codex', 'bad');
  const { CLIProvider } = await import('../src/cli-provider.js');
  await expect(
    new CLIProvider('codex', f.config).complete(request),
  ).rejects.toThrow(/structured|arguments|protocol/i);
});
test('CLI watchdog terminates a hung native process', async () => {
  const f = native('codex', 'hang');
  const { CLIProvider } = await import('../src/cli-provider.js');
  const start = Date.now();
  await expect(
    new CLIProvider('codex', f.config).complete({
      ...request,
      signal: AbortSignal.timeout(300),
    }),
  ).rejects.toThrow(/timeout|abort|timed|pause/i);
  expect(Date.now() - start).toBeLessThan(2000);
});
test('role routing bills subscriptions without API-price reservations', async () => {
  const f = native('codex');
  const { createProvider } = await import('../src/provider-factory.js');
  const { Memory } = await import('../src/memory.js');
  const { BudgetProvider } = await import('../src/budget.js');
  const { TracedProvider, TraceStore } = await import('../src/trace.js');
  const memory = new Memory(f.root),
    trace = new TraceStore(memory.dir);
  const provider = createProvider(f.config, memory),
    usage = { tokens: 0, cost: 0 };
  try {
    const budget = new BudgetProvider(
      new TracedProvider(provider, trace, () => ({
        runId: 'routing',
        taskId: 'T1',
      })),
      { ...f.config, maxCost: 0.000001 },
      usage,
    );
    await expect(budget.complete(request)).resolves.toMatchObject({
      content: 'working',
    });
    expect(usage).toEqual({ tokens: 24, cost: 0 });
  } finally {
    trace.close();
  }
});

test('watchdog still stops the native CLI after its harness parent is SIGKILLed', async () => {
  const { spawn } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const root = fixture(),
    script = join(root, 'slow.mjs'),
    ready = join(root, 'ready'),
    late = join(root, 'late');
  writeFileSync(
    script,
    `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>fs.writeFileSync(${JSON.stringify(late)},'escaped watchdog'),1400);setInterval(()=>{},100);`,
  );
  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      resolve('tests/cli-watchdog-child.mjs'),
      root,
      script,
    ],
    { stdio: 'ignore' },
  );
  const closed = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  const until = Date.now() + 2000;
  while (!existsSync(ready) && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(existsSync(ready)).toBe(true);
  child.kill('SIGKILL');
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 1600));
  expect(existsSync(late)).toBe(false);
});
test('hybrid role routing reaches the correct native CLIs', async () => {
  const codex = native('codex'),
    claude = native('claude');
  const { createProvider } = await import('../src/provider-factory.js');
  const { Memory } = await import('../src/memory.js');
  const config = ConfigSchema.parse({
    ...codex.config,
    roleProviders: { verifier: 'claude-cli' },
    cli: { ...codex.config.cli, claude: claude.config.cli.claude },
  });
  const provider = createProvider(config, new Memory(codex.root));
  await provider.complete(request);
  await provider.complete({ ...request, role: 'verifier', model: 'sonnet' });
  expect(codex.calls()).toHaveLength(2);
  expect(claude.calls()).toHaveLength(2);
  expect(provider.billingFor?.('verifier')).toBe('subscription');
});

test('malformed native decisions still charge their valid reported usage durably', async () => {
  const f = native('codex', 'bad');
  const { CLIProvider } = await import('../src/cli-provider.js');
  const { Orchestrator } = await import('../src/orchestrator.js');
  const { Memory } = await import('../src/memory.js');
  const { PlanSchema } = await import('../src/schema.js');
  const { plan } = await import('./helpers.js');
  ignoreArtifacts(f.root);
  const memory = new Memory(f.root);
  memory.savePlan(PlanSchema.parse(plan));
  const config = { ...f.config, verificationCommands: [], maxTokens: 10000 };
  await new Orchestrator(
    f.root,
    config,
    new CLIProvider('codex', config),
  ).run();
  expect(memory.checkpoint()!.usage.tokens).toBe(24);
  expect(memory.checkpoint()!.stopReason).toMatch(
    /structured|arguments|protocol/i,
  );
  expect(memory.checkpoint()!.taskId).toBe('T1');
  await new Orchestrator(
    f.root,
    config,
    new CLIProvider('codex', config),
  ).run();
  expect(memory.checkpoint()!.usage.tokens).toBe(48);
});

for (const kind of ['codex', 'claude'] as const) {
  test(`${kind} accounts valid usage on a nonzero quota exit`, async () => {
    const f = native(kind, 'quota-usage');
    const { CLIProvider } = await import('../src/cli-provider.js');
    const { BudgetProvider } = await import('../src/budget.js');
    const usage = { tokens: 0, cost: 0 };
    await expect(
      new BudgetProvider(
        new CLIProvider(kind, f.config),
        f.config,
        usage,
      ).complete(request),
    ).rejects.toThrow(/quota|limit/);
    expect(usage.tokens).toBe(24);
    expect(f.calls()).toHaveLength(2);
  });
}
test('reported failure usage survives SIGKILL before checkpoint accounting exactly once', async () => {
  const { spawn } = await import('node:child_process');
  const { resolve } = await import('node:path');
  const { CLIProvider } = await import('../src/cli-provider.js');
  const { Orchestrator } = await import('../src/orchestrator.js');
  const { Memory } = await import('../src/memory.js');
  const { PlanSchema } = await import('../src/schema.js');
  const { plan } = await import('./helpers.js');
  const f = native('codex', 'bad');
  ignoreArtifacts(f.root);
  const memory = new Memory(f.root);
  memory.savePlan(PlanSchema.parse(plan));
  memory.write('config.json', JSON.stringify(f.config));
  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      resolve('tests/cli-failure-child.mjs'),
      f.root,
    ],
    { stdio: 'pipe' },
  );
  const result = await new Promise<string | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (_code, signal) => resolve(signal));
  });
  expect(result).toBe('SIGKILL');
  expect(memory.checkpoint()!.usage.tokens).toBe(0);
  const limited = { ...f.config, maxTokens: 30 };
  for (let i = 0; i < 2; i++)
    await new Orchestrator(
      f.root,
      limited,
      new CLIProvider('codex', limited),
    ).run();
  expect(memory.checkpoint()!.usage.tokens).toBe(24);
  expect(memory.checkpoint()!.chargedFailureEvents).toHaveLength(1);
  expect(f.calls()).toHaveLength(2);
});
