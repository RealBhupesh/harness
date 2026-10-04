import { z } from 'zod';
const Id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
export const CriterionSchema = z.discriminatedUnion('kind', [
  z.object({
    id: Id,
    description: z.string().min(1),
    kind: z.literal('fileContains'),
    path: z.string().min(1),
    text: z.string().min(1),
  }),
  z.object({
    id: Id,
    description: z.string().min(1),
    kind: z.literal('command'),
    argv: z.array(z.string()).min(2),
  }),
]);
export const TaskSchema = z.object({
  id: Id,
  title: z.string().min(1),
  description: z.string().min(1),
  acceptance: z.array(CriterionSchema).min(1),
  dependencies: z.array(Id),
  size: z.enum(['S', 'M', 'L']),
  status: z.enum(['todo', 'in_progress', 'blocked', 'done', 'failed']),
  attempts: z.number().int().min(0),
  priority: z.number().int().default(0),
  notes: z.array(z.string()).default([]),
});
export const PlanSchema = z
  .object({
    objective: z.string().min(1),
    milestones: z
      .array(
        z.object({
          id: Id,
          title: z.string().min(1),
          tasks: z.array(TaskSchema).min(1),
        }),
      )
      .min(1),
  })
  .superRefine((plan, ctx) => {
    const tasks = plan.milestones.flatMap((m) => m.tasks);
    const map = new Map(tasks.map((t) => [t.id, t]));
    if (map.size !== tasks.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate task IDs' });
    if (
      new Set(plan.milestones.map((m) => m.id)).size !== plan.milestones.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate milestone IDs' });
    for (const task of tasks) {
      if (
        new Set(task.acceptance.map((c) => c.id)).size !==
        task.acceptance.length
      )
        ctx.addIssue({ code: 'custom', message: 'Duplicate criterion IDs' });
      if (task.dependencies.some((d) => !map.has(d)))
        ctx.addIssue({
          code: 'custom',
          message: `Unknown dependency on ${task.id}`,
        });
    }
    const active = new Set<string>(),
      seen = new Set<string>();
    function visit(id: string): boolean {
      if (active.has(id)) return true;
      if (seen.has(id)) return false;
      active.add(id);
      for (const dep of map.get(id)?.dependencies ?? [])
        if (visit(dep)) return true;
      active.delete(id);
      seen.add(id);
      return false;
    }
    if (tasks.some((t) => visit(t.id)))
      ctx.addIssue({ code: 'custom', message: 'Cyclic dependencies' });
  });
export type Plan = z.infer<typeof PlanSchema>;
export type Task = z.infer<typeof TaskSchema>;
export const ProviderSchema = z.enum([
  'mock',
  'openai',
  'anthropic',
  'codex-cli',
  'claude-cli',
]);
const CLICommandSchema = (command: string) =>
  z
    .object({
      command: z
        .string()
        .min(1)
        .refine((s) => !s.includes('\0')),
      args: z.array(z.string()).default([]),
    })
    .default({ command, args: [] });
export const ConfigSchema = z.object({
  provider: ProviderSchema.default('mock'),
  roleProviders: z
    .object({
      planner: ProviderSchema.optional(),
      worker: ProviderSchema.optional(),
      verifier: ProviderSchema.optional(),
    })
    .default({}),
  cli: z
    .object({
      codex: CLICommandSchema('codex'),
      claude: CLICommandSchema('claude'),
      timeoutMs: z.number().int().positive().default(120000),
      maxResponseBytes: z.number().int().min(1024).max(4000000).default(256000),
      effort: z
        .object({
          planner: z.enum(['low', 'medium', 'high']).default('medium'),
          worker: z.enum(['low', 'medium', 'high']).default('low'),
          verifier: z.enum(['low', 'medium', 'high']).default('medium'),
        })
        .default({ planner: 'medium', worker: 'low', verifier: 'medium' }),
    })
    .default({
      codex: { command: 'codex', args: [] },
      claude: { command: 'claude', args: [] },
      timeoutMs: 120000,
      maxResponseBytes: 256000,
      effort: { planner: 'medium', worker: 'low', verifier: 'medium' },
    }),
  models: z
    .object({ planner: z.string(), worker: z.string(), verifier: z.string() })
    .default({ planner: 'mock', worker: 'mock', verifier: 'mock' }),
  parallel: z.number().int().min(1).max(8).default(1),
  maxOutputTokens: z.number().int().positive().default(2048),
  roleOutputTokens: z
    .object({
      planner: z.number().int().positive().default(2048),
      worker: z.number().int().positive().default(2048),
      verifier: z.number().int().positive().default(1024),
    })
    .default({ planner: 2048, worker: 2048, verifier: 1024 }),
  context: z
    .object({
      enabled: z.boolean().default(true),
      maxPromptBytes: z.number().int().min(2048).default(48000),
      maxEntryBytes: z.number().int().min(256).default(4000),
      maxEvidenceBytes: z.number().int().min(256).default(1200),
    })
    .default({
      enabled: true,
      maxPromptBytes: 48000,
      maxEntryBytes: 4000,
      maxEvidenceBytes: 1200,
    }),
  prices: z
    .object({
      planner: z.object({
        input: z.number().positive(),
        output: z.number().positive(),
      }),
      worker: z.object({
        input: z.number().positive(),
        output: z.number().positive(),
      }),
      verifier: z.object({
        input: z.number().positive(),
        output: z.number().positive(),
      }),
    })
    .default({
      planner: { input: 5, output: 15 },
      worker: { input: 5, output: 15 },
      verifier: { input: 5, output: 15 },
    }),
  maxAttempts: z.number().int().min(1).max(3).default(3),
  maxSteps: z.number().int().positive().default(30),
  taskTimeoutMs: z.number().int().positive().default(120000),
  commandTimeoutMs: z.number().int().positive().default(60000),
  maxOutputBytes: z.number().int().positive().default(16000),
  maxTokens: z.number().int().positive().default(100000),
  maxCost: z.number().positive().default(10),
  maxWallTimeMs: z.number().int().positive().default(3600000),
  maxTasks: z.number().int().positive().default(20),
  verificationCommands: z.array(z.array(z.string()).min(2)).default([
    ['pnpm', 'test'],
    ['pnpm', 'typecheck'],
    ['pnpm', 'lint'],
  ]),
});
export type Config = z.infer<typeof ConfigSchema>;
export const defaultConfig = () =>
  ConfigSchema.parse({ verificationCommands: [] });
export const ToolCallSchema = z.object({
  name: z.enum(['read', 'write', 'patch', 'search', 'command', 'git']),
  args: z.record(z.string(), z.unknown()),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;
export const PhaseSchema = z.enum([
  'SELECT',
  'PREPARE_CONTEXT',
  'EXECUTE',
  'VERIFY',
  'COMMIT',
  'REFLECT',
]);
export type Phase = z.infer<typeof PhaseSchema>;
export const CheckpointSchema = z.object({
  phase: PhaseSchema,
  taskId: z.string().nullable(),
  baseBranch: z.string().nullable(),
  branch: z.string().nullable(),
  baseSha: z.string().nullable(),
  runId: z.string(),
  completed: z.number().int(),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string(),
    }),
  ),
  steps: z.number().int(),
  taskStarted: z.number(),
  taskActiveMs: z.number().nonnegative().default(0),
  stopReason: z.string().nullable(),
  snapshotPlan: PlanSchema.optional(),
  verificationTree: z.string().nullable().default(null),
  pendingMutation: z
    .object({
      path: z.string(),
      before: z.string().nullable(),
      after: z.string(),
    })
    .nullable()
    .default(null),
  pendingTools: z.array(ToolCallSchema).default([]),
  toolIndex: z.number().int().nonnegative().default(0),
  awaitingToolFinish: z.boolean().default(false),
  usage: z
    .object({
      tokens: z.number().nonnegative(),
      cost: z.number().nonnegative(),
    })
    .default({ tokens: 0, cost: 0 }),
  activeWallMs: z.number().nonnegative().default(0),
  mockCursor: z.number().int().nonnegative().default(0),
  chargedPlanningCalls: z.array(z.string()).default([]),
  chargedFailureEvents: z.array(z.string()).default([]),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;
export const allTasks = (plan: Plan) => plan.milestones.flatMap((m) => m.tasks);
