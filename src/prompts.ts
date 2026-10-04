import { createHash } from 'node:crypto';
import { BudgetExceeded } from './budget.js';
import type { Message, Request } from './provider.js';
import type { Config, Task } from './schema.js';
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
export const digest = (text: string) =>
  createHash('sha256').update(text).digest('hex');
// Preserve UTF-8 boundaries and both the beginning and end of diagnostics.
export function compactText(text: string, limit: number): string {
  const data = Buffer.from(text);
  if (data.length <= limit) return text;
  const marker = `\n[truncated ${data.length} bytes; sha256:${digest(text)}]\n`;
  const room = Math.max(0, limit - Buffer.byteLength(marker));
  let end = Math.floor(room / 2),
    start = data.length - (room - end);
  while (end > 0 && (data[end]! & 0xc0) === 0x80) end--;
  while (start < data.length && (data[start]! & 0xc0) === 0x80) start++;
  return (
    data.subarray(0, end).toString() + marker + data.subarray(start).toString()
  );
}
export function promptTask(task: Task, limit: number): Task {
  return {
    ...task,
    notes: task.notes.map((note) =>
      /^(Attempt \d+ failed|Parallel attempt \d+:)/.test(note)
        ? compactText(note, limit)
        : note,
    ),
  };
}
function compactValue(value: unknown, limit: number, key = ''): unknown {
  if (typeof value === 'string')
    return compactText(
      value,
      ['content', 'oldText', 'newText'].includes(key)
        ? Math.min(limit, 256)
        : limit,
    );
  if (Array.isArray(value))
    return value.map((item) => compactValue(item, limit));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        compactValue(item, limit, name),
      ]),
    );
  return value;
}
function shorten(message: Message, limit: number): Message {
  if (failedCommand(message)) {
    if (bytes(message) <= limit) return { ...message };
    const data = JSON.parse(message.content) as {
      tool: string;
      args: unknown;
      result: string;
    };
    const result = JSON.parse(data.result) as {
      code: number;
      stdout: string;
      stderr: string;
      truncated: boolean;
    };
    const diagnostics = `${result.stdout}\n${result.stderr}`
      .split('\n')
      .filter((line) =>
        /error|fail|expected|actual|assert|not ok|✖/i.test(line),
      )
      .slice(-20)
      .join('\n');
    const room = Math.max(256, Math.floor(limit / 4));
    const content = JSON.stringify({
      tool: data.tool,
      args: data.args,
      result: {
        code: result.code,
        diagnostics: compactText(diagnostics, room),
        stdout: compactText(result.stdout, room),
        stderr: compactText(result.stderr, room),
        truncated: result.truncated,
        sha256: digest(data.result),
      },
    });
    return { ...message, content: compactText(content, limit) };
  }
  let content: string;
  try {
    content = JSON.stringify(
      compactValue(
        JSON.parse(message.content),
        Math.max(256, Math.floor(limit / 3)),
      ),
    );
  } catch {
    content = message.content;
  }
  return { ...message, content: compactText(content, limit) };
}
function failedCommand(message: Message): boolean {
  try {
    const data = JSON.parse(message.content) as {
      tool?: string;
      result?: string;
    };
    if (data.tool !== 'command' || !data.result) return false;
    const result = JSON.parse(data.result) as { code?: number };
    return typeof result.code === 'number' && result.code !== 0;
  } catch {
    return false;
  }
}
function observationKey(message: Message): string | undefined {
  try {
    const data = JSON.parse(message.content) as {
      tool?: string;
      args?: unknown;
      result?: unknown;
    };
    if (
      message.role === 'user' &&
      ['read', 'search', 'git'].includes(data.tool ?? '') &&
      typeof data.result === 'string'
    )
      return digest(JSON.stringify([data.tool, data.args, data.result]));
  } catch {
    /* Other exchanges carry intent and remain in context. */
  }
  return undefined;
}
export function workerPrompt(
  messages: Message[],
  config: Config,
): Pick<Request, 'messages' | 'promptStats' | 'canonicalMessages'> {
  const originalBytes = bytes(messages);
  if (!config.context.enabled)
    return {
      canonicalMessages: messages,
      messages: messages.map((m) => ({ ...m })),
      promptStats: {
        originalBytes,
        sentBytes: originalBytes,
        omittedMessages: 0,
      },
    };
  const pinned = messages.slice(0, 2).map((m) => ({ ...m }));
  const history = messages
    .slice(2)
    .map((m) => shorten(m, config.context.maxEntryBytes));
  const latestFailure = messages.slice(2).map(failedCommand).lastIndexOf(true);
  const keep = new Set(history.map((_, i) => i));
  const dropped: number[] = [];
  const seen = new Set<string>();
  for (let i = history.length - 1; i >= 0; i--) {
    const key = observationKey(messages[i + 2]!);
    if (!key) continue;
    if (seen.has(key) && i < history.length - 2) {
      keep.delete(i);
      dropped.push(i);
    }
    seen.add(key);
  }
  dropped.sort((a, b) => a - b);
  const render = () => [
    ...pinned,
    ...(dropped.length
      ? [
          {
            role: 'user' as const,
            content: `${dropped.length} earlier messages omitted to fit context; sha256:${digest(dropped.map((i) => messages[i + 2]!.content).join('\n'))}. Re-read relevant files in small pages or rerun checks if details are needed. Full transcript remains in durable traces.`,
          },
        ]
      : []),
    ...history.filter((_, i) => keep.has(i)),
  ];
  let result = render();
  if (dropped.length && bytes(result) >= bytes([...pinned, ...history])) {
    for (const i of dropped) keep.add(i);
    dropped.length = 0;
    result = render();
  }
  for (
    let i = 0;
    bytes(result) > config.context.maxPromptBytes && i < history.length;
    i++
  ) {
    if (!keep.has(i) || i === latestFailure || i >= history.length - 2)
      continue;
    keep.delete(i);
    dropped.push(i);
    result = render();
  }
  if (bytes(result) > config.context.maxPromptBytes)
    throw new BudgetExceeded(
      'Essential task or recent context exceeds maxPromptBytes; increase the context limit or split the task.',
    );
  return {
    canonicalMessages: messages,
    messages: result,
    promptStats: {
      originalBytes,
      sentBytes: bytes(result),
      omittedMessages: dropped.length,
    },
  };
}

export function evidencePrompt(
  evidence: { id: string; check: string; output: string }[],
  task: Task,
  limit: number,
) {
  return evidence.map((entry) => {
    if (Buffer.byteLength(entry.output) <= limit) return { ...entry };
    let preview = entry.output;
    const criterion = task.acceptance.find((c) => c.id === entry.id);
    if (criterion?.kind === 'fileContains') {
      const index = entry.output.indexOf(criterion.text);
      if (index >= 0)
        preview = entry.output.slice(
          Math.max(0, index - 200),
          index + criterion.text.length + 200,
        );
    } else
      try {
        const result = JSON.parse(entry.output) as {
          code?: number;
          stdout?: string;
          stderr?: string;
          truncated?: boolean;
        };
        preview =
          typeof result.code === 'number'
            ? JSON.stringify({
                code: result.code,
                truncated: result.truncated,
                stdout: compactText(
                  result.stdout ?? '',
                  Math.max(256, Math.floor(limit / 3)),
                ),
                stderr: compactText(
                  result.stderr ?? '',
                  Math.max(256, Math.floor(limit / 3)),
                ),
              })
            : entry.output;
      } catch {
        /* Non-command evidence remains a bounded text excerpt. */
      }
    return {
      ...entry,
      output: compactText(preview, limit),
      bytes: Buffer.byteLength(entry.output),
      sha256: digest(entry.output),
    };
  });
}
