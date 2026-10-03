import { redact } from './redact.js';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  lstatSync,
  realpathSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CheckpointSchema,
  PlanSchema,
  allTasks,
  type Checkpoint,
  type Plan,
} from './schema.js';
export function atomicWrite(path: string, content: string) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, redact(content));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}
export class Memory {
  readonly dir: string;
  constructor(readonly root: string) {
    this.root = realpathSync(root);
    this.dir = join(this.root, '.relay');
    try {
      if (lstatSync(this.dir).isSymbolicLink())
        throw new Error('.relay must not be a symlink');
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
    mkdirSync(this.dir, { recursive: true });
  }
  private path(name: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
      throw new Error('Invalid memory filename');
    const path = join(this.dir, name);
    try {
      if (lstatSync(path).isSymbolicLink())
        throw new Error('Memory files must not be symlinks');
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
    return path;
  }
  read(name: string): string {
    const path = this.path(name);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }
  write(name: string, content: string) {
    atomicWrite(this.path(name), content);
  }
  append(name: string, content: string) {
    appendFileSync(
      this.path(name),
      `${new Date().toISOString()} ${redact(content)}\n`,
      { mode: 0o600 },
    );
  }
  loadPlan(): Plan {
    return PlanSchema.parse(JSON.parse(this.read('plan.json')));
  }
  savePlan(plan: Plan) {
    plan = PlanSchema.parse(plan);
    this.write('plan.json', JSON.stringify(plan, null, 2) + '\n');
    this.write(
      'PLAN.md',
      `# ${plan.objective}\n\n` +
        plan.milestones
          .map(
            (m) =>
              `## ${m.id}: ${m.title}\n\n` +
              m.tasks
                .map(
                  (t) =>
                    `- [${t.status === 'done' ? 'x' : ' '}] ${t.id}: ${t.title} (${t.status}, attempt ${t.attempts})\n  Acceptance: ${t.acceptance.map((c) => c.description).join('; ')}\n  Dependencies: ${t.dependencies.join(', ') || 'none'}`,
                )
                .join('\n'),
          )
          .join('\n\n'),
    );
  }
  checkpoint(): Checkpoint | null {
    const text = this.read('checkpoint.json');
    return text ? CheckpointSchema.parse(JSON.parse(text)) : null;
  }
  saveCheckpoint(value: Checkpoint) {
    this.write(
      'checkpoint.json',
      JSON.stringify(CheckpointSchema.parse(value), null, 2),
    );
  }
  state(plan: Plan, cp: Checkpoint) {
    const tasks = allTasks(plan),
      done = tasks.filter((t) => t.status === 'done'),
      current = tasks.find((t) => t.id === cp.taskId);
    this.write(
      'STATE.md',
      `# Relay state\n\nCurrent milestone: ${plan.milestones.find((m) => m.tasks.some((t) => t.id === cp.taskId))?.title ?? 'none'}\nCurrent task: ${current?.id ?? 'none'}\nPhase: ${cp.phase}\nLast completed task: ${done.at(-1)?.id ?? 'none'}\nOverall: ${Math.round((done.length / tasks.length) * 100)}% (${done.length}/${tasks.length})\nKnown blockers: ${
        tasks
          .filter((t) => t.status === 'blocked')
          .map((t) => `${t.id}: ${t.notes.at(-1)}`)
          .join('; ') || 'none'
      }\nStop reason: ${cp.stopReason ?? 'none'}\nNext action: ${cp.stopReason ?? (done.length === tasks.length ? 'Review completed results.' : `Run relay resume to continue ${cp.phase}${cp.taskId ? ' for ' + cp.taskId : ''}.`)}\n`,
    );
  }
}
