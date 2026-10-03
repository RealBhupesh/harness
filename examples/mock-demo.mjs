import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve(process.argv[2] ?? '/tmp/relay-demo');
const parallel = process.argv.includes('--parallel');
if (existsSync(root))
  throw new Error('Choose a new empty destination for the demo.');
mkdirSync(root, { recursive: true });
const git = (...args) =>
  execFileSync('git', args, { cwd: root, stdio: 'pipe' });
git('init', '-b', 'main');
git('config', 'user.name', 'Relay Demo');
git('config', 'user.email', 'relay@example.test');
writeFileSync(join(root, 'GOAL.md'), 'Create a tested greeting function.\n');
writeFileSync(
  join(root, '.gitignore'),
  '.relay/checkpoint.json\n.relay/run.lock\n.relay/*.sqlite*\n.relay/traces.jsonl\n.relay/report.html\n.relay/worktrees/\n',
);
git('add', '.');
git('commit', '-m', 'chore: initialize demo');
mkdirSync(join(root, '.relay'));
const plan = {
  objective: 'Create a tested greeting function',
  milestones: [
    {
      id: 'M1',
      title: 'Greeting',
      tasks: [
        {
          id: 'T1',
          title: 'Add greeting',
          description: 'Export greet(name) and test its output.',
          acceptance: [
            {
              id: 'A1',
              description: 'Greeting test passes',
              kind: 'command',
              argv: ['node', '--test', 'greet.test.mjs'],
            },
          ],
          dependencies: [],
          size: 'S',
          status: 'todo',
          attempts: 0,
          priority: 1,
        },
      ],
    },
  ],
};
if (parallel) {
  const second = JSON.parse(JSON.stringify(plan.milestones[0].tasks[0]));
  second.id = 'T2';
  second.title = 'Add second greeting';
  second.acceptance[0].argv = ['node', '--test', 'second.test.mjs'];
  plan.milestones[0].tasks.push(second);
}
writeFileSync(join(root, '.relay/plan.json'), JSON.stringify(plan));
writeFileSync(
  join(root, '.relay/config.json'),
  JSON.stringify({
    verificationCommands: [['node', '--test']],
  }),
);
writeFileSync(
  join(root, '.relay/mock.json'),
  JSON.stringify([
    {
      content: '',
      toolCalls: [
        {
          name: 'write',
          args: {
            path: 'greet.mjs',
            content: 'export const greet = (name) => `Hello ${name}!`;\n',
          },
        },
        {
          name: 'write',
          args: {
            path: 'greet.test.mjs',
            content:
              "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from './greet.mjs';\ntest('greeting', () => assert.equal(greet('Relay'), 'Hello Relay!'));\n",
          },
        },
      ],
    },
    { content: 'Greeting implemented.', toolCalls: [] },
    {
      content: JSON.stringify({
        criteria: [
          {
            id: 'A1',
            passed: true,
            evidence: 'node --test greet.test.mjs passed',
          },
        ],
        summary: 'Greeting verified',
      }),
    },
  ]),
);
const cli = resolve('dist/src/cli.js');
if (parallel) {
  const script = JSON.parse(
    (await import('node:fs')).readFileSync(
      join(root, '.relay/mock.json'),
      'utf8',
    ),
  );
  writeFileSync(join(root, '.relay/mock-T1.json'), JSON.stringify(script));
  writeFileSync(
    join(root, '.relay/mock-T2.json'),
    JSON.stringify(script).replaceAll('greet.', 'second.'),
  );
}
execFileSync(
  process.execPath,
  [cli, 'run', ...(parallel ? ['--parallel', '2', '--max-tasks', '2'] : [])],
  { cwd: root, stdio: 'inherit' },
);
execFileSync(process.execPath, [cli, 'status'], {
  cwd: root,
  stdio: 'inherit',
});
console.log(`Demo repository: ${root}`);
