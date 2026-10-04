import { createHash } from 'node:crypto';
import { runCommand } from './command.js';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { ToolCallSchema, type Config, type ToolCall } from './schema.js';
export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
};
const hidden =
  /(^|\/)(\.git|\.relay|node_modules|dist|\.env[^/]*|.*\.(pem|key))($|\/)/;
export class ToolRunner {
  readonly root: string;
  constructor(
    root: string,
    readonly config: Config,
  ) {
    this.root = realpathSync(root);
  }
  path(value: string): string {
    if (
      isAbsolute(value) ||
      value.includes('\0') ||
      hidden.test(value.replaceAll('\\', '/'))
    )
      throw new Error('Protected or absolute path');
    const target = resolve(this.root, value),
      rel = relative(this.root, target);
    if (!rel || rel === '..' || rel.startsWith('..' + sep))
      throw new Error('Path escapes repository');
    let parent = target;
    while (!existsSync(parent)) parent = dirname(parent);
    const real = realpathSync(parent),
      r = relative(this.root, real);
    if (r === '..' || r.startsWith('..' + sep))
      throw new Error('Symlink escapes repository');
    // Reject symlinks even within the root, including dangling symlinks.
    let current = this.root;
    for (const part of rel.split(sep)) {
      current = resolve(current, part);
      try {
        if (lstatSync(current).isSymbolicLink())
          throw new Error('Symlink tool paths are forbidden');
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ))
          throw error;
      }
    }
    return target;
  }
  async command(argv: string[], signal?: AbortSignal): Promise<CommandResult> {
    const [bin, sub, ...args] = argv;
    const allowed =
      (bin === 'node' && (sub === '--test' || sub === '--check')) ||
      (bin === 'pnpm' &&
        ['test', 'typecheck', 'lint', 'build'].includes(sub ?? '') &&
        args.length === 0);
    if (!allowed)
      throw new Error(
        'Command denied by allowlist; shell execution is forbidden',
      );
    if (bin === 'node')
      for (const arg of args) {
        if (arg.startsWith('-')) throw new Error('Node flags are forbidden');
        this.path(arg);
      }
    return this.spawn(argv, signal);
  }
  async git(argv: string[], signal?: AbortSignal): Promise<CommandResult> {
    if (argv.length !== 1 || !['status', 'diff', 'log'].includes(argv[0] ?? ''))
      throw new Error(
        'Git tool accepts only a status, diff or log operation without arguments',
      );
    const args =
      argv[0] === 'status'
        ? ['status', '--short']
        : argv[0] === 'log'
          ? ['log', '-10', '--oneline']
          : ['diff', '--no-ext-diff', '--no-textconv'];
    return this.spawn(
      ['git', '-c', 'core.hooksPath=/dev/null', ...args],
      signal,
    );
  }
  private spawn(argv: string[], signal?: AbortSignal): Promise<CommandResult> {
    return runCommand(this.root, this.config, argv, signal);
  }
  mutation(
    call: ToolCall,
  ): { path: string; before: string | null; after: string } | null {
    if (!['write', 'patch'].includes(call.name)) return null;
    const args = z
      .object({
        path: z.string(),
        content: z.string().optional(),
        oldText: z.string().optional(),
        newText: z.string().optional(),
      })
      .parse(call.args);
    const path = this.path(args.path),
      before = existsSync(path) ? readFileSync(path, 'utf8') : null;
    let after: string;
    if (call.name === 'write') after = z.string().parse(args.content);
    else {
      const patch = z
        .object({ oldText: z.string().min(1), newText: z.string() })
        .parse(args);
      if (before === null || before.split(patch.oldText).length !== 2)
        throw new Error('Patch must match exactly once');
      after = before.replace(patch.oldText, patch.newText);
    }
    const hash = (value: string) =>
      createHash('sha256').update(value).digest('hex');
    return {
      path: args.path,
      before: before === null ? null : hash(before),
      after: hash(after),
    };
  }
  reconcile(mutation: {
    path: string;
    before: string | null;
    after: string;
  }): 'applied' | 'pending' {
    const path = this.path(mutation.path),
      current = existsSync(path)
        ? createHash('sha256').update(readFileSync(path)).digest('hex')
        : null;
    if (current === mutation.after) return 'applied';
    if (current === mutation.before) return 'pending';
    throw new Error(
      'File diverged from checkpointed mutation; refusing overwrite',
    );
  }
  async run(raw: ToolCall, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw signal.reason;
    const call = ToolCallSchema.parse(raw);
    if (call.name === 'command')
      return JSON.stringify(
        await this.command(
          z.object({ argv: z.array(z.string()).min(2) }).parse(call.args).argv,
          signal,
        ),
      );
    if (call.name === 'git')
      return JSON.stringify(
        await this.git(
          z.object({ argv: z.array(z.string()).min(1) }).parse(call.args).argv,
          signal,
        ),
      );
    if (call.name === 'search') {
      const { query } = z
        .object({ query: z.string().min(1).max(200) })
        .parse(call.args);
      return this.search(query);
    }
    const args = z
        .object({
          path: z.string(),
          content: z.string().optional(),
          oldText: z.string().optional(),
          newText: z.string().optional(),
          startLine: z.number().int().positive().optional(),
          maxLines: z.number().int().positive().max(1000).optional(),
        })
        .parse(call.args),
      path = this.path(args.path);
    if (call.name === 'read') {
      const content = readFileSync(path, 'utf8');
      if (args.startLine !== undefined || args.maxLines !== undefined) {
        const start = (args.startLine ?? 1) - 1;
        const lines = content.split('\n');
        const selected = lines.slice(start, start + (args.maxLines ?? 100));
        const data = Buffer.from(selected.join('\n'));
        let end = Math.min(data.length, this.config.maxOutputBytes);
        while (end > 0 && end < data.length && (data[end]! & 0xc0) === 0x80)
          end--;
        return data.subarray(0, end).toString();
      }
      return content.slice(0, this.config.maxOutputBytes);
    }
    if (call.name === 'write') {
      if (args.content === undefined) throw new Error('write requires content');
      if (Buffer.byteLength(args.content) > this.config.maxOutputBytes * 10)
        throw new Error('Write exceeds limit');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, args.content);
      return `Wrote ${args.path}`;
    }
    const { oldText, newText } = z
      .object({ oldText: z.string().min(1), newText: z.string() })
      .parse(args);
    const content = readFileSync(path, 'utf8');
    if (content.split(oldText).length !== 2)
      throw new Error('Patch must match exactly once');
    writeFileSync(path, content.replace(oldText, newText));
    return `Patched ${args.path}`;
  }
  search(query: string): string {
    const matches: string[] = [];
    let visited = 0;
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (visited++ > 500 || matches.length >= 30) return;
        const rel = relative(this.root, resolve(dir, entry.name)).replaceAll(
          '\\',
          '/',
        );
        if (hidden.test(rel) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(resolve(dir, entry.name));
        else if (entry.isFile()) {
          try {
            const content = readFileSync(
              resolve(dir, entry.name),
              'utf8',
            ).slice(0, 16000);
            if (rel.includes(query) || content.includes(query))
              matches.push(`${rel}: ${content.slice(0, 600)}`);
          } catch {
            /* Ignore unreadable search candidates. */
          }
        }
      }
    };
    walk(this.root);
    return matches.join('\n').slice(0, this.config.maxOutputBytes);
  }
}
