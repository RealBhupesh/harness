const deadlines = new WeakMap<AbortSignal, number>();
export function deadlineSignal(ms: number): AbortSignal {
  const signal = AbortSignal.timeout(Math.max(1, Math.floor(ms)));
  deadlines.set(signal, Date.now() + ms);
  return signal;
}
export function deadlineOf(signal?: AbortSignal): number {
  return signal ? (deadlines.get(signal) ?? Infinity) : Infinity;
}
