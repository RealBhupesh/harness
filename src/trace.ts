import Database from 'better-sqlite3';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { redact } from './redact.js';
import { allTasks } from './schema.js';
import type { Memory } from './memory.js';
import type { LLMProvider, Request, Response } from './provider.js';
import { ToolRunner, type CommandResult } from './tools.js';
import type { ToolCall, Config } from './schema.js';
export type TraceContext = { runId: string; taskId: string | null };
const EventSchema = z.object({
  id: z.string(),
  time: z.string(),
  runId: z.string(),
  taskId: z.string().nullable(),
  kind: z.string(),
  payload: z.string(),
});
export type Event = z.infer<typeof EventSchema>;
export class TraceStore {
  readonly db: Database.Database;
  constructor(readonly dir: string) {
    this.db = new Database(join(dir, 'traces.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, time TEXT NOT NULL, runId TEXT NOT NULL, taskId TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS events_task ON events(taskId);',
    );
  }
  record(kind: string, payload: unknown, context: TraceContext) {
    const event = EventSchema.parse({
      id: randomUUID(),
      time: new Date().toISOString(),
      ...context,
      kind,
      payload: redact(JSON.stringify(payload)),
    });
    this.db
      .prepare(
        'INSERT INTO events VALUES (@id,@time,@runId,@taskId,@kind,@payload)',
      )
      .run(event);
    appendFileSync(
      join(this.dir, 'traces.jsonl'),
      JSON.stringify(event) + '\n',
      { mode: 0o600 },
    );
  }
  events(taskId?: string): Event[] {
    const rows = taskId
      ? this.db
          .prepare('SELECT * FROM events WHERE taskId=? ORDER BY rowid')
          .all(taskId)
      : this.db.prepare('SELECT * FROM events ORDER BY rowid').all();
    return z.array(EventSchema).parse(rows);
  }
  close() {
    this.db.close();
  }
}
export class TracedProvider implements LLMProvider {
  constructor(
    readonly inner: LLMProvider,
    readonly trace: TraceStore,
    readonly context: () => TraceContext,
  ) {}
  async complete(request: Request): Promise<Response> {
    const started = Date.now();
    try {
      const response = await this.inner.complete(request);
      this.trace.record(
        'llm',
        {
          role: request.role,
          model: request.model,
          messages: request.messages,
          response,
          durationMs: Date.now() - started,
        },
        this.context(),
      );
      return response;
    } catch (error) {
      this.trace.record(
        'llm_error',
        {
          role: request.role,
          message: error instanceof Error ? error.message : String(error),
        },
        this.context(),
      );
      throw error;
    }
  }
}
export class TracedTools extends ToolRunner {
  constructor(
    root: string,
    config: Config,
    readonly trace: TraceStore,
    readonly context: () => TraceContext,
  ) {
    super(root, config);
  }
  override async run(call: ToolCall, signal?: AbortSignal): Promise<string> {
    try {
      const result = await super.run(call, signal);
      this.trace.record('tool', { call, result }, this.context());
      return result;
    } catch (error) {
      this.trace.record(
        'tool_error',
        {
          call,
          message: error instanceof Error ? error.message : String(error),
        },
        this.context(),
      );
      throw error;
    }
  }
  override async command(
    argv: string[],
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    const result = await super.command(argv, signal);
    this.trace.record('command', { argv, result }, this.context());
    return result;
  }
}
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
export function report(memory: Memory, trace: TraceStore) {
  const plan = memory.loadPlan(),
    tasks = allTasks(plan),
    done = tasks.filter((t) => t.status === 'done').length,
    cp = memory.checkpoint();
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Relay report</title><style>body{font:16px system-ui;max-width:1000px;margin:40px auto;padding:0 20px;background:#101827;color:#e5edf7}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:10px;border-bottom:1px solid #475569}pre{white-space:pre-wrap;overflow-wrap:anywhere}details{margin:12px 0}</style><h1>${escape(plan.objective)}</h1><p>${Math.round((done / tasks.length) * 100)}% complete · ${done}/${tasks.length} tasks · ${cp?.usage.tokens ?? 0} tokens · estimated $${(cp?.usage.cost ?? 0).toFixed(4)}</p><p>${escape(cp?.stopReason ?? 'Running')}</p><h2>Tasks and failures</h2><table><tr><th>Task</th><th>Status</th><th>Attempts</th><th>Latest note</th></tr>${tasks.map((t) => `<tr><td>${escape(t.id + ': ' + t.title)}</td><td>${escape(t.status)}</td><td>${t.attempts}</td><td>${escape(t.notes.at(-1) ?? '')}</td></tr>`).join('')}</table><h2>Timeline (last 200 events)</h2>${trace
    .events()
    .slice(-200)
    .map(
      (e) =>
        `<details><summary>${escape(`${e.time} ${e.taskId ?? '-'} ${e.kind}`)}</summary><pre>${escape(e.payload)}</pre></details>`,
    )
    .join('')}</html>`;
  memory.write('report.html', html);
}
