import { TrackedPosition, HealthStatus } from './types';
import {
  getTradeLogs,
  getCurrentBlockNumber,
  getPosition,
  calculateMarginHealth,
  type TradeExecutedLog,
} from './blockchain';
import { config } from './config';

// In-memory index. A restart replays from START_BLOCK; for production, persist
// (account, marketId, lastSyncedBlock) so restarts are cheap.
const trackedPositions = new Map<string, TrackedPosition>();
let lastSyncedBlock: bigint = config.startBlock - 1n;

function positionKey(account: string, marketId: string): string {
  return `${account.toLowerCase()}:${marketId.toLowerCase()}`;
}

/**
 * TradeExecuted carries the post-trade newSize, so a single handler covers
 * opens, resizes, closes and liquidations: newSize == 0 means flat.
 */
function applyTradeLog(log: TradeExecutedLog): void {
  const marketId = log.args.marketId!.toLowerCase() as `0x${string}`;
  if (config.marketIds.size > 0 && !config.marketIds.has(marketId)) return;

  const account = log.args.user!.toLowerCase() as `0x${string}`;
  const key = positionKey(account, marketId);
  const newSize = log.args.newSize!;

  if (newSize === 0n) {
    trackedPositions.delete(key);
    return;
  }

  const existing = trackedPositions.get(key);
  trackedPositions.set(key, {
    account,
    marketId,
    size: newSize,
    updatedBlock: log.blockNumber!,
    lastChecked: existing?.lastChecked ?? 0,
    healthStatus: existing?.healthStatus ?? HealthStatus.SAFE,
  });
}

async function syncRange(fromBlock: bigint, toBlock: bigint): Promise<number> {
  if (toBlock < fromBlock) return 0;

  let total = 0;
  for (let start = fromBlock; start <= toBlock; start += config.logChunkSize) {
    const end = start + config.logChunkSize - 1n > toBlock ? toBlock : start + config.logChunkSize - 1n;
    const logs = await getTradeLogs(start, end);
    for (const log of logs) applyTradeLog(log);
    total += logs.length;
    if (logs.length > 0) {
      console.log(`Indexed TradeExecuted ${start}-${end}: ${logs.length} log(s)`);
    }
  }

  lastSyncedBlock = toBlock;
  return total;
}

export async function initializeTracker(): Promise<void> {
  const currentBlock = await getCurrentBlockNumber();
  console.log(`Backfilling TradeExecuted from block ${config.startBlock} to ${currentBlock}...`);

  const count = await syncRange(config.startBlock, currentBlock);
  console.log(`Backfill complete: ${count} log(s), ${trackedPositions.size} open position(s)`);
}

export async function syncNewEvents(): Promise<void> {
  const currentBlock = await getCurrentBlockNumber();
  if (currentBlock <= lastSyncedBlock) return;
  await syncRange(lastSyncedBlock + 1n, currentBlock);
}

export function getAllTrackedPositions(): TrackedPosition[] {
  return Array.from(trackedPositions.values());
}

export function updateTrackedPosition(
  account: `0x${string}`,
  marketId: `0x${string}`,
  updates: Partial<TrackedPosition>
): void {
  const key = positionKey(account, marketId);
  const existing = trackedPositions.get(key);
  if (existing) trackedPositions.set(key, { ...existing, ...updates });
}

export function removePosition(account: `0x${string}`, marketId: `0x${string}`): void {
  trackedPositions.delete(positionKey(account, marketId));
}

/** Track an account explicitly, bypassing event discovery (--track). */
export async function trackSpecificAccount(
  account: `0x${string}`,
  marketId: `0x${string}`
): Promise<void> {
  const position = await getPosition(account, marketId);
  if (position.size === 0n) {
    console.log(`${account} has no open position in ${marketId}`);
    return;
  }

  const health = await calculateMarginHealth(account, marketId, position);
  trackedPositions.set(positionKey(account, marketId), {
    account,
    marketId,
    size: position.size,
    updatedBlock: 0n,
    lastChecked: Date.now(),
    healthStatus: health.status,
  });

  console.log(`Tracking ${account} in ${marketId} (size ${position.size}, ${health.status})`);
}

export function getTrackerStats(): {
  total: number;
  safe: number;
  warning: number;
  liquidatable: number;
} {
  const positions = getAllTrackedPositions();
  return {
    total: positions.length,
    safe: positions.filter((p) => p.healthStatus === HealthStatus.SAFE).length,
    warning: positions.filter((p) => p.healthStatus === HealthStatus.WARNING).length,
    liquidatable: positions.filter((p) => p.healthStatus === HealthStatus.LIQUIDATABLE).length,
  };
}
