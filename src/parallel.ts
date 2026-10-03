import { existsSync } from 'node:fs';
import { ResponseSchema } from './provider.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  allTasks,
  CheckpointSchema,
  PlanSchema,
  type Config,
  type Task,
} from './schema.js';
import { Memory } from './memory.js';
import { Git } from './git.js';
import { RunLock } from './lock.js';
import { Orchestrator } from './orchestrator.js';
import { TraceStore, report } from './trace.js';
import { ToolRunner } from './tools.js';
import { deadlineSignal } from './limits.js';
import type { LLMProvider } from './provider.js';
const EntrySchema = z.object({
  taskId: z.string(),
  branch: z.string(),
  baseSha: z.string(),
  stage: z.enum([
    'running',
    'verified',
    'merging',
    'reverting',
    'done',
    'failed',
  ]),
  accounted: z.object({ tokens: z.number(), cost: z.number() }),
  mergeBase: z.string().nullable(),
  mergeTree: z.string().nullable(),
  mergeSha: z.string().nullable(),
  failure: z.string().nullable(),
  tracesCopied: z.boolean(),
  verifiedSha: z.string().nullable().default(null),
  verifiedTree: z.string().nullable().default(null),
});
const JournalSchema = z.object({
  plan: PlanSchema,
  checkpoint: CheckpointSchema,
  width: z.number().int().min(1).max(8),
  baseBranch: z.string(),
  entries: z.array(EntrySchema),
});
type Entry = z.infer<typeof EntrySchema>;
export class ParallelCoordinator {
  readonly memory: Memory;
  readonly git: Git;
  constructor(
    readonly root: string,
    readonly config: Config,
    readonly factory: (task: Task) => LLMProvider,
  ) {
    this.memory = new Memory(root);
    this.git = new Git(root);
  }
  async run(
    width: number,
    maxTasks = this.config.maxTasks,
  ): Promise<{ completed: number; reason: string }> {
    width = z.number().int().min(1).max(8).parse(width);
    maxTasks = Math.min(
      z.number().int().positive().parse(maxTasks),
      this.config.maxTasks,
    );
    const release = new RunLock(this.memory.dir).acquire();
    let store: TraceStore;
    try {
      store = new TraceStore(this.memory.dir);
    } catch (error) {
      release();
      throw error;
    }
    try {
      const initial = this.memory.checkpoint();
      if (initial?.taskId)
        throw new Error(
          'Resume the active serial task before enabling parallel execution',
        );
      const old = this.memory.read('parallel.json');
      const journal = old
        ? JournalSchema.parse(JSON.parse(old))
        : JournalSchema.parse({
            plan: this.memory.loadPlan(),
            checkpoint:
              initial ??
              CheckpointSchema.parse({
                phase: 'SELECT',
                taskId: null,
                baseBranch: null,
                branch: null,
                baseSha: null,
                runId: randomUUID(),
                completed: 0,
                messages: [],
                steps: 0,
                taskStarted: 0,
                stopReason: null,
              }),
            width,
            baseBranch: this.git.branch(),
            entries: [],
          });
      journal.width = width;
      const cp = journal.checkpoint,
        plan = journal.plan,
        start = cp.completed;
      const admitted = new Set(
        journal.entries
          .filter((e) => !['done', 'failed'].includes(e.stage))
          .slice(0, maxTasks)
          .map((e) => e.branch),
      );
      let attemptsStarted = admitted.size,
        lastTick = Date.now();
      cp.stopReason = null;
      const save = () => {
        const now = Date.now();
        cp.activeWallMs += now - lastTick;
        lastTick = now;
        cp.snapshotPlan = plan;
        this.memory.write('parallel.json', JSON.stringify(journal, null, 2));
        this.memory.saveCheckpoint(cp);
        this.memory.savePlan(plan);
        this.memory.state(plan, cp);
      };
      const remainingWall = () =>
        this.config.maxWallTimeMs - cp.activeWallMs - (Date.now() - lastTick);
      const taskFor = (entry: Entry) => {
        const task = allTasks(plan).find((t) => t.id === entry.taskId);
        if (!task) throw new Error('Parallel journal references unknown task');
        return task;
      };
      const fail = (entry: Entry, message: string) => {
        const task = taskFor(entry);
        task.notes.push(`Parallel attempt ${task.attempts}: ${message}`);
        task.status =
          task.attempts >= this.config.maxAttempts ? 'blocked' : 'todo';
        entry.stage = 'failed';
        entry.failure = message;
        this.memory.append(
          'LOG.md',
          `${task.id}: ${message}. Worktree preserved ${entry.branch}`,
        );
        if (task.status === 'blocked')
          this.memory.append('QUESTIONS.md', `OPEN ${task.id}: ${message}`);
        store.record(
          'parallel_failure',
          { message },
          { runId: cp.runId, taskId: task.id },
        );
        save();
      };
      const checks = async (entry: Entry) => {
        const ms = remainingWall();
        if (ms <= 0)
          throw new Error('Run wall-time budget reached during integration');
        const signal = deadlineSignal(ms),
          tools = new ToolRunner(this.root, this.config);
        for (const argv of this.config.verificationCommands) {
          const result = await tools.command(argv, signal);
          store.record(
            'merge_check',
            { argv, result },
            { runId: cp.runId, taskId: entry.taskId },
          );
          if (result.code !== 0)
            throw new Error(
              `integration regression: ${argv.join(' ')}: ${result.stderr}`,
            );
        }
        for (const c of taskFor(entry).acceptance) {
          if (c.kind === 'fileContains') {
            if (
              !(
                await tools.run(
                  { name: 'read', args: { path: c.path } },
                  signal,
                )
              ).includes(c.text)
            )
              throw new Error(`integration regression: ${c.id}`);
          } else if ((await tools.command(c.argv, signal)).code !== 0)
            throw new Error(`integration regression: ${c.id}`);
        }
      };
      const revert = (entry: Entry) => {
        const head = this.git.run(['rev-parse', 'HEAD']);
        if (
          this.git
            .run(['log', '-1', '--format=%s'])
            .startsWith(`revert(${entry.taskId}):`)
        ) {
          fail(entry, entry.failure ?? 'integration regression');
          return;
        }
        if (head !== entry.mergeSha)
          throw new Error(
            'Main branch changed during rollback; inspect preserved journal',
          );
        if (!this.git.run(['diff', '--cached', '--name-only']))
          this.git.run(['revert', '--no-commit', '-m', '1', entry.mergeSha!]);
        if (
          this.git.run(['write-tree']) !==
          this.git.run(['rev-parse', `${entry.mergeBase}^{tree}`])
        )
          throw new Error(
            'Rollback artifact differs from expected previous tree',
          );
        this.git.run([
          'commit',
          '-m',
          `revert(${entry.taskId}): integration regression`,
        ]);
        fail(entry, entry.failure ?? 'integration regression');
      };
      const account = (entry: Entry) => {
        const path = this.git.worktree(entry.branch);
        if (!existsSync(path)) return;
        const memory = new Memory(path);
        if (memory.read('worker-owner.json') !== entry.branch) return;
        const child = memory.checkpoint(),
          ledger = new TraceStore(memory.dir);
        let observed = { tokens: 0, cost: 0 };
        try {
          for (const event of ledger
            .events(entry.taskId)
            .filter((e) => e.kind === 'llm')) {
            const response = ResponseSchema.parse(
              (JSON.parse(event.payload) as { response: unknown }).response,
            );
            observed.tokens += response.usage.tokens;
            observed.cost += response.usage.cost;
          }
        } finally {
          ledger.close();
        }
        observed = {
          tokens: Math.max(
            observed.tokens,
            child?.usage.tokens ?? 0,
            entry.accounted.tokens,
          ),
          cost: Math.max(
            observed.cost,
            child?.usage.cost ?? 0,
            entry.accounted.cost,
          ),
        };
        cp.usage.tokens += observed.tokens - entry.accounted.tokens;
        cp.usage.cost += observed.cost - entry.accounted.cost;
        entry.accounted = observed;
      };
      let paused = false;
      save();
      while (cp.completed - start < maxTasks && !paused) {
        for (const entry of journal.entries) account(entry);
        save();
        if (this.git.branch() !== journal.baseBranch)
          throw new Error('Restore the recorded main branch before recovery');
        // A rollback is local safety cleanup, independent of remaining model/run budgets.
        for (const entry of journal.entries)
          if (entry.stage === 'reverting') revert(entry);
        if (
          cp.usage.tokens >= this.config.maxTokens ||
          cp.usage.cost >= this.config.maxCost ||
          remainingWall() <= 0
        ) {
          for (const entry of journal.entries) {
            if (entry.stage !== 'merging') continue;
            const head = this.git.run(['rev-parse', 'HEAD']);
            if (head === entry.mergeBase) continue;
            if (
              this.git.run(['rev-parse', 'HEAD^{tree}']) !== entry.mergeTree ||
              !this.git
                .run(['log', '-1', '--format=%s'])
                .startsWith(`merge(${entry.taskId}):`)
            )
              throw new Error(
                'Unexpected main artifact during budget recovery',
              );
            entry.mergeSha = head;
            entry.stage = 'reverting';
            entry.failure =
              'Integration was interrupted before verification and the run budget is exhausted';
            save();
            revert(entry);
          }
          cp.stopReason =
            'Parallel run budget reached; increase caps to resume.';
          break;
        }
        if (this.git.branch() !== journal.baseBranch)
          throw new Error(
            'Main checkout branch changed; restore the recorded branch before resuming',
          );
        const pending = journal.entries.filter(
          (e) => !['done', 'failed'].includes(e.stage),
        );
        let active = pending.filter((entry) => admitted.has(entry.branch));
        if (!active.length) {
          if (pending.length) {
            cp.stopReason = 'Task attempt budget reached; run relay resume.';
            break;
          }
          const tasks = allTasks(plan),
            ready = tasks
              .filter(
                (t) =>
                  t.status === 'todo' &&
                  t.dependencies.every(
                    (d) => tasks.find((x) => x.id === d)?.status === 'done',
                  ),
              )
              .sort((a, b) => b.priority - a.priority)
              .slice(0, Math.min(width, maxTasks - attemptsStarted));
          if (!ready.length) {
            cp.stopReason = tasks.every((t) => t.status === 'done')
              ? 'All tasks complete.'
              : attemptsStarted >= maxTasks
                ? 'Task attempt budget reached; run relay resume.'
                : 'No runnable tasks; review .relay/QUESTIONS.md.';
            break;
          }
          journal.entries = ready.map((task) => {
            task.status = 'in_progress';
            task.attempts++;
            attemptsStarted++;
            return {
              taskId: task.id,
              branch: `relay/parallel/${task.id}/${randomUUID().slice(0, 8)}`,
              baseSha: this.git.run(['rev-parse', 'HEAD']),
              stage: 'running',
              accounted: { tokens: 0, cost: 0 },
              mergeBase: null,
              mergeTree: null,
              mergeSha: null,
              failure: null,
              tracesCopied: false,
              verifiedSha: null,
              verifiedTree: null,
            };
          });
          save();
          active = journal.entries;
          for (const entry of active) admitted.add(entry.branch);
        }
        const running = active
            .filter((e) => e.stage === 'running')
            .slice(0, width),
          availableTokens = Math.max(
            0,
            this.config.maxTokens - cp.usage.tokens,
          ),
          availableCost = Math.max(0, this.config.maxCost - cp.usage.cost),
          availableWall = remainingWall();
        await Promise.all(
          running.map(async (entry) => {
            try {
              const path = this.git.prepare(entry.branch, entry.baseSha),
                memory = new Memory(path),
                task = taskFor(entry);
              if (!memory.read('worker-owner.json')) {
                memory.savePlan(
                  PlanSchema.parse({
                    objective: plan.objective,
                    milestones: [
                      {
                        id: 'Worker',
                        title: task.title,
                        tasks: [
                          {
                            ...task,
                            status: 'todo',
                            attempts: 0,
                            dependencies: [],
                          },
                        ],
                      },
                    ],
                  }),
                );
                memory.write('checkpoint.json', '');
                memory.write('worker-owner.json', entry.branch);
              } else if (memory.read('worker-owner.json') !== entry.branch)
                throw new Error('Unexpected worker memory owner');
              const child = memory.checkpoint(),
                childConfig = {
                  ...this.config,
                  maxAttempts: 1,
                  maxTasks: 1,
                  maxTokens:
                    entry.accounted.tokens +
                    Math.floor(availableTokens / running.length),
                  maxCost:
                    entry.accounted.cost + availableCost / running.length,
                  maxWallTimeMs: (child?.activeWallMs ?? 0) + availableWall,
                };
              await new Orchestrator(path, childConfig, this.factory(task)).run(
                1,
              );
              account(entry);
              {
                const childTrace = new TraceStore(memory.dir);
                try {
                  const copied = new Set(
                    store
                      .events(task.id)
                      .map(
                        (e) =>
                          (JSON.parse(e.payload) as { sourceEvent?: string })
                            .sourceEvent,
                      ),
                  );
                  for (const event of childTrace.events(task.id))
                    if (!copied.has(event.id))
                      store.record(
                        event.kind,
                        {
                          sourceEvent: event.id,
                          worker: event.runId,
                          payload: JSON.parse(event.payload),
                        },
                        { runId: cp.runId, taskId: task.id },
                      );
                } finally {
                  childTrace.close();
                }
              }
              const outcome = allTasks(memory.loadPlan())[0]!;
              if (outcome.status === 'done') {
                const workerGit = new Git(path);
                entry.verifiedSha = workerGit.run(['rev-parse', 'HEAD']);
                entry.verifiedTree = workerGit.run([
                  'rev-parse',
                  'HEAD^{tree}',
                ]);
                if (
                  entry.verifiedTree !==
                    memory.checkpoint()?.verificationTree ||
                  workerGit.changes().length
                )
                  throw new Error('Worker artifact changed after verification');
                entry.stage = 'verified';
                save();
              } else if (outcome.status === 'blocked')
                fail(entry, outcome.notes.at(-1) ?? 'Worker failed');
              else save();
            } catch (error) {
              fail(
                entry,
                error instanceof Error ? error.message : String(error),
              );
            }
          }),
        );
        if (running.some((e) => e.stage === 'running')) {
          cp.stopReason = 'Worker budget stopped; increase caps and resume.';
          break;
        }
        for (const entry of active) {
          if (entry.stage === 'reverting') {
            revert(entry);
            continue;
          }
          if (!['verified', 'merging'].includes(entry.stage)) continue;
          if (entry.stage === 'verified') {
            if (
              !entry.verifiedSha ||
              !entry.verifiedTree ||
              this.git.run(['rev-parse', entry.branch]) !== entry.verifiedSha ||
              this.git.run(['rev-parse', `${entry.verifiedSha}^{tree}`]) !==
                entry.verifiedTree
            ) {
              fail(
                entry,
                'Worker branch changed from its independently verified artifact',
              );
              continue;
            }
            if (this.git.changes().length)
              throw new Error(
                'Main checkout has user changes; commit or preserve them before integration',
              );
            entry.mergeBase = this.git.run(['rev-parse', 'HEAD']);
            try {
              entry.mergeTree = this.git
                .run([
                  'merge-tree',
                  '--write-tree',
                  entry.mergeBase,
                  entry.verifiedSha,
                ])
                .split('\n')[0]!;
            } catch {
              fail(
                entry,
                'Merge conflict; task requeued with preserved worktree',
              );
              continue;
            }
            entry.stage = 'merging';
            save();
          }
          const head = this.git.run(['rev-parse', 'HEAD']);
          if (head === entry.mergeBase)
            this.git.run([
              'merge',
              '--no-ff',
              '--no-edit',
              '-m',
              `merge(${entry.taskId}): verified task`,
              entry.verifiedSha!,
            ]);
          else if (
            !this.git
              .run(['log', '-1', '--format=%s'])
              .startsWith(`merge(${entry.taskId}):`)
          )
            throw new Error(
              'Main branch changed during merge recovery; inspect journal',
            );
          entry.mergeSha = this.git.run(['rev-parse', 'HEAD']);
          if (this.git.run(['rev-parse', 'HEAD^{tree}']) !== entry.mergeTree)
            throw new Error(
              'Recovered merge tree differs from recorded artifact',
            );
          save();
          try {
            if (this.git.changes().length)
              throw new Error(
                'Main checkout contains changes from interrupted verification',
              );
            await checks(entry);
            if (
              this.git.changes().length ||
              this.git.run(['rev-parse', 'HEAD']) !== entry.mergeSha ||
              this.git.run(['rev-parse', 'HEAD^{tree}']) !== entry.mergeTree
            )
              throw new Error(
                'Merge checks changed the pinned checkout artifact',
              );
          } catch (error) {
            if (
              this.git.changes().length ||
              this.git.run(['rev-parse', 'HEAD']) !== entry.mergeSha
            ) {
              entry.failure =
                'Merge verification changed the checkout; preserve or inspect changes before resuming.';
              cp.stopReason = entry.failure;
              this.memory.append(
                'QUESTIONS.md',
                `OPEN ${entry.taskId}: ${entry.failure}`,
              );
              paused = true;
              save();
              break;
            }
            entry.failure =
              error instanceof Error ? error.message : String(error);
            entry.stage = 'reverting';
            save();
            revert(entry);
            continue;
          }
          taskFor(entry).status = 'done';
          entry.stage = 'done';
          cp.completed++;
          this.memory.append('LOG.md', `Merged and checked ${entry.taskId}`);
          store.record(
            'merged',
            { sha: entry.mergeSha },
            { runId: cp.runId, taskId: entry.taskId },
          );
          save();
        }
      }
      cp.stopReason ??= allTasks(plan).every((task) => task.status === 'done')
        ? 'All tasks complete.'
        : 'Task attempt budget reached; run relay resume.';
      save();
      report(this.memory, store);
      return { completed: cp.completed - start, reason: cp.stopReason };
    } finally {
      store.close();
      release();
    }
  }
}
