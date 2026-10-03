import { spawn } from 'node:child_process';
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
  async git(argv: string[]): Promise<CommandResult> {
    if (
      !['status', 'diff', 'log'].includes(argv[0] ?? '') ||
      argv.some((arg) => arg.startsWith('--output') || arg.includes('\0'))
    )
      throw new Error('Git tool only permits status, diff, log');
    return this.spawn(['git', ...argv]);
  }
  private spawn(argv: string[], signal?: AbortSignal): Promise<CommandResult> {
    return new Promise((resolveResult, reject) => {
      const safeEnv: NodeJS.ProcessEnv = {};
      for (const name of [
        'PATH',
        'LANG',
        'LC_ALL',
        'HOME',
        'COREPACK_HOME',
        'npm_config_cache',
        'npm_config_devdir',
        'NODE_EXTRA_CA_CERTS',
        'SSL_CERT_FILE',
      ])
        if (process.env[name]) safeEnv[name] = process.env[name];
      safeEnv.GIT_PAGER = 'cat';
      safeEnv.CI = '1';
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: this.root,
        env: safeEnv,
        shell: false,
        detached: process.platform !== 'win32',
        signal,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '',
        bytes = 0,
        truncated = false,
        timedOut = false;
      const capture = (kind: 'out' | 'err', data: Buffer) => {
        const room = Math.max(0, this.config.maxOutputBytes - bytes);
        const text = data.subarray(0, room).toString();
        bytes += data.length;
        truncated ||= bytes > this.config.maxOutputBytes;
        if (kind === 'out') stdout += text;
        else stderr += text;
      };
      child.stdout.on('data', (d: Buffer) => capture('out', d));
      child.stderr.on('data', (d: Buffer) => capture('err', d));
      const kill = () => {
        if (child.pid) {
          try {
            process.kill(
              process.platform === 'win32' ? child.pid : -child.pid,
              'SIGKILL',
            );
          } catch {
            child.kill('SIGKILL');
          }
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, this.config.commandTimeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        kill();
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolveResult({
          code: timedOut ? 124 : (code ?? 1),
          stdout,
          stderr: stderr + (timedOut ? '\nCommand timeout' : ''),
          truncated,
        });
      });
    });
  }
  async run(raw: ToolCall, signal?: AbortSignal): Promise<string> {
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
        })
        .parse(call.args),
      path = this.path(args.path);
    if (call.name === 'read') {
      const content = readFileSync(path, 'utf8');
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
    if (!content.includes(oldText) && content.split(newText).length === 2)
      return `Already patched ${args.path}`;
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
