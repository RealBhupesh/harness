import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
export class Git {
  constructor(readonly root: string) {}
  run(args: string[]): string {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: this.root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
      },
    }).trimEnd();
  }
  branch(): string {
    const name = this.run(['branch', '--show-current']);
    if (!name) throw new Error('Relay requires a named branch');
    return name;
  }
  changes(): string[] {
    return this.run(['status', '--porcelain', '--untracked-files=all'])
      .split('\n')
      .filter(Boolean)
      .filter((line) => !line.slice(3).startsWith('.relay/'));
  }
  worktree(branch: string): string {
    return join(this.root, '.relay', 'worktrees', branch.replaceAll('/', '-'));
  }
  prepare(branch: string, baseSha: string): string {
    const path = this.worktree(branch);
    if (existsSync(path)) return path;
    if (this.changes().length)
      throw new Error('Repository must be clean before a task');
    mkdirSync(join(this.root, '.relay', 'worktrees'), { recursive: true });
    this.run(['worktree', 'add', '-b', branch, path, baseSha]);
    const modules = join(this.root, 'node_modules');
    if (existsSync(modules))
      symlinkSync(modules, join(path, 'node_modules'), 'dir');
    return path;
  }
  diff(): string {
    this.run(['add', '--all', '--', '.', ':(exclude).relay']);
    return this.run(['diff', '--cached', '--no-ext-diff', '--no-textconv']);
  }
  commit(taskId: string, title: string, expectedTree?: string) {
    this.run(['add', '--all', '--', '.', ':(exclude).relay']);
    if (expectedTree && this.run(['write-tree']) !== expectedTree)
      throw new Error('Verification artifact changed before commit');
    const names = this.run(['diff', '--cached', '--name-only', '-z'])
      .split('\0')
      .filter(Boolean);
    if (names.some((name) => /(^|\/)(\.env[^/]*|.*\.(pem|key))$/.test(name)))
      throw new Error('Secret file detected');
    const diff = this.run([
      'diff',
      '--cached',
      '--no-ext-diff',
      '--no-textconv',
    ]);
    if (
      this.run(['diff', '--cached', '--diff-filter=D', '--name-only', '-z'])
        .split('\0')
        .filter(Boolean).length > 5
    )
      throw new Error(
        'Human approval required for deleting more than five files',
      );
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/.test(
        diff,
      )
    )
      throw new Error('Potential secret detected in staged changes');
    if (!names.length) throw new Error('No task changes to commit');
    this.run([
      'commit',
      '-m',
      `feat(${taskId}): ${title.replace(/[\r\n]/g, ' ').slice(0, 120)}`,
    ]);
  }
  integrate(base: string, branch: string) {
    this.run(['checkout', base]);
    this.run(['merge', '--ff-only', branch]);
  }
}
