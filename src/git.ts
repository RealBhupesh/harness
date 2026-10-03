import { execFileSync } from 'node:child_process';
export class Git {
  constructor(readonly root: string) {}
  run(args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
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
  prepare(branch: string) {
    if (this.branch() === branch) return;
    if (this.changes().length)
      throw new Error('Repository must be clean before a task');
    this.run(['checkout', '-b', branch]);
  }
  commit(taskId: string, title: string) {
    this.run(['add', '--all', '--', '.', ':(exclude).relay']);
    const names = this.run(['diff', '--cached', '--name-only'])
      .split('\n')
      .filter(Boolean);
    if (names.some((name) => /(^|\/)(\.env[^/]*|.*\.(pem|key))$/.test(name)))
      throw new Error('Secret file detected');
    const diff = this.run(['diff', '--cached', '--no-ext-diff']);
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
  merge(base: string, branch: string) {
    this.run(['checkout', base]);
    if (this.run(['merge-base', '--is-ancestor', branch, base]) === '') return;
  }
  integrate(base: string, branch: string) {
    this.run(['checkout', base]);
    this.run(['merge', '--ff-only', branch]);
  }
}
