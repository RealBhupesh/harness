import { afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const roots: string[] = [];
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'relay-test-'));
  roots.push(root);
  execFileSync('git', ['init', '-b', 'main', root]);
  execFileSync('git', ['config', 'user.email', 'relay@example.test'], {
    cwd: root,
  });
  execFileSync('git', ['config', 'user.name', 'Relay Test'], { cwd: root });
  writeFileSync(
    join(root, '.gitignore'),
    '.relay/checkpoint.json\n.relay/run.lock\n.relay/*.sqlite*\n.relay/traces.jsonl\n.relay/report.html\n.relay/worktrees/\n',
  );
  writeFileSync(join(root, 'GOAL.md'), 'Create a greeting file.');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: root });
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
export const task = {
  id: 'T1',
  title: 'Greeting',
  description: 'Write hello.txt',
  acceptance: [
    {
      id: 'A1',
      description: 'Greeting exists',
      kind: 'fileContains',
      path: 'hello.txt',
      text: 'Hello Relay',
    },
  ],
  dependencies: [],
  size: 'S',
  status: 'todo',
  attempts: 0,
  priority: 1,
};
export const plan = {
  objective: 'Greeting',
  milestones: [{ id: 'M1', title: 'First greeting', tasks: [task] }],
};
