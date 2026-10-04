import { ResponseSchema } from './provider.js';
import type { Checkpoint } from './schema.js';
import type { TraceStore } from './trace.js';
export function reconcileFailureUsage(cp: Checkpoint, trace: TraceStore) {
  const charged = new Set(cp.chargedFailureEvents);
  for (const event of trace.events()) {
    if (
      event.kind !== 'llm_error' ||
      event.runId !== cp.runId ||
      charged.has(event.id)
    )
      continue;
    const data = JSON.parse(event.payload) as { usage?: unknown };
    const usage = ResponseSchema.shape.usage.safeParse(data.usage);
    if (data.usage === undefined || !usage.success) continue;
    cp.usage.tokens += usage.data.tokens;
    cp.usage.cost += usage.data.cost;
    cp.chargedFailureEvents.push(event.id);
    charged.add(event.id);
  }
}
