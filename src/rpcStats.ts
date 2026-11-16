import type { Transport } from 'viem';

/**
 * Counts JSON-RPC requests per method. Wrap any viem transport with
 * countingTransport(); startRpcStatsLogger() prints an RPC_STATS line every
 * interval so call volume is visible in the Railway logs.
 */
const counts = new Map<string, number>();
let total = 0;
let windowTotal = 0;
const windowCounts = new Map<string, number>();
const startedAt = Date.now();

function record(method: string): void {
  total++;
  windowTotal++;
  counts.set(method, (counts.get(method) ?? 0) + 1);
  windowCounts.set(method, (windowCounts.get(method) ?? 0) + 1);
}

export function countingTransport<T extends Transport>(inner: T): T {
  const wrapped = ((opts: Parameters<T>[0]) => {
    const t = inner(opts);
    return {
      ...t,
      request: (async (args: { method: string }, options?: unknown) => {
        record(args.method);
        return (t.request as any)(args, options);
      }) as typeof t.request,
    };
  }) as unknown as T;
  return wrapped;
}

export function getRpcStats() {
  return {
    total,
    sinceStartMinutes: Math.round((Date.now() - startedAt) / 60_000),
    byMethod: Object.fromEntries(counts),
  };
}

function fmt(m: Map<string, number>): string {
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
}

export function startRpcStatsLogger(intervalMs = 10 * 60_000): void {
  const timer = setInterval(() => {
    const minutes = intervalMs / 60_000;
    console.log(
      `RPC_STATS window=${minutes}m calls=${windowTotal} perDay≈${Math.round((windowTotal * 1440) / minutes)} ` +
        `total=${total} [${fmt(windowCounts)}]`
    );
    windowTotal = 0;
    windowCounts.clear();
  }, intervalMs);
  timer.unref();
}
