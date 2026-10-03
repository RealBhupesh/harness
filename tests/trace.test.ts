import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, plan } from './helpers.js';
import { Memory } from '../src/memory.js';
import { PlanSchema, defaultConfig } from '../src/schema.js';
import { TraceStore, report } from '../src/trace.js';
import { Orchestrator } from '../src/orchestrator.js';
import { MockProvider } from '../src/provider.js';
test('trace persistence survives restart, redacts keys and escapes report markup', () => {
  const root = fixture(),
    memory = new Memory(root);
  const p = PlanSchema.parse(plan);
  p.objective = '<script>alert(1)</script>';
  memory.savePlan(p);
  const store = new TraceStore(memory.dir);
  store.record(
    'llm',
    { text: 'sk-abcdefghijklmnopqrstuvwxyz12345' },
    { runId: 'r', taskId: 'T1' },
  );
  store.close();
  const reopened = new TraceStore(memory.dir);
  expect(reopened.events('T1')).toHaveLength(1);
  expect(readFileSync(join(memory.dir, 'traces.jsonl'), 'utf8')).not.toContain(
    'sk-abcdefghijklmnopqrstuvwxyz12345',
  );
  report(memory, reopened);
  const html = memory.read('report.html');
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;');
  reopened.close();
});
test('a real mock run records LLM, tool and phase events in SQLite and JSONL', async () => {
  const memory = new Memory(fixture());
  memory.savePlan(PlanSchema.parse(plan));
  const provider = new MockProvider([
    {
      content: '',
      toolCalls: [
        { name: 'write', args: { path: 'hello.txt', content: 'Hello Relay' } },
      ],
    },
    { content: 'done' },
    {
      content: JSON.stringify({
        criteria: [{ id: 'A1', passed: true, evidence: 'Greeting checked' }],
        summary: 'Verified',
      }),
    },
  ]);
  await new Orchestrator(memory.root, defaultConfig(), provider).run();
  const store = new TraceStore(memory.dir);
  const events = store.events('T1');
  expect(events.some((e) => e.kind === 'llm')).toBe(true);
  expect(events.some((e) => e.kind === 'tool')).toBe(true);
  expect(events.some((e) => e.kind === 'transition')).toBe(true);
  expect(memory.read('report.html')).toContain('100%');
  store.close();
});
test('trace metadata symlinks cannot redirect writes outside the repository', async () => {
  const { symlinkSync, writeFileSync } = await import('node:fs');
  for (const name of ['traces.jsonl', 'traces.sqlite']) {
    const memory = new Memory(fixture()),
      outside = join(fixture(), 'outside.txt');
    writeFileSync(outside, 'untouched');
    symlinkSync(outside, join(memory.dir, name));
    expect(() => new TraceStore(memory.dir)).toThrow('Metadata');
    expect(readFileSync(outside, 'utf8')).toBe('untouched');
  }
});
