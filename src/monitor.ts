import { formatUnits } from 'viem';
import { config } from './config';
import {
  readCycleSnapshot,
  refreshMarketMeta,
  getCachedMarketMeta,
  isStaleOracleError,
  errorMessage,
  type CycleSnapshot,
  type PositionRead,
} from './blockchain';
import {
  getAllTrackedPositions,
  updateTrackedPosition,
  removePosition,
  syncPositions,
  getTrackerStats,
  getLastTradeBlock,
} from './tracker';
import { sendEmailAlert } from './notifications';
import { executeLiquidationSafely, pokeFundingSafely, logExecutionStats } from './executor';
import { HealthStatus, AlertData, MarginHealth, MarketMeta, MarketSnapshot, TrackedPosition } from './types';

const WAD = 10n ** 18n;
const MAX_UINT = 2n ** 256n - 1n;
const SEPOLIA_BLOCK_SEC = 12n;
const MARKET_STATUS_EVERY_MS = 10 * 60_000;

// Surfaced over the health endpoint so a stalled loop is externally visible.
const state = {
  ready: false,
  cycle: 0,
  head: 0n,
  lastCycleAt: null as number | null,
  lastSyncedBlock: null as bigint | null,
  lastError: null as string | null,
  lastMarketStatusAt: 0,
};

const staleMarkets = new Set<string>();

export function getMonitorState() {
  return { ...state };
}

/** Called once after the tracker has loaded; `head` seeds the first cycle. */
export function markReady(head: bigint): void {
  state.ready = true;
  state.head = head;
}

/**
 * Health from the cycle multicall. isLiquidatable() is the sole authority for
 * LIQUIDATABLE (it folds in pending funding and collateral valuation).
 * WARNING uses getMarginRatio (effective margin / notional-at-mark, including
 * funding) against IMR - approximate, alert-only.
 */
function buildHealth(
  p: TrackedPosition,
  read: PositionRead,
  meta: MarketMeta,
  snap: MarketSnapshot
): MarginHealth {
  const absSize = p.size < 0n ? -p.size : p.size;
  const price = snap.markPriceX18 ?? snap.indexPriceX18 ?? 0n;
  const notionalValue = (absSize * price) / WAD;
  const initialMargin = (notionalValue * meta.risk.imrBps) / 10_000n;
  const maintenanceMargin = (notionalValue * meta.risk.mmrBps) / 10_000n;

  const ratio = read.marginRatioX18 !== null && read.marginRatioX18 !== MAX_UINT ? read.marginRatioX18 : null;
  const effectiveMargin = ratio !== null ? (ratio * notionalValue) / WAD : 0n;

  let status = HealthStatus.SAFE;
  if (read.liquidatable) status = HealthStatus.LIQUIDATABLE;
  else if (ratio !== null && ratio * 10_000n < meta.risk.imrBps * WAD) status = HealthStatus.WARNING;

  return {
    effectiveMargin,
    maintenanceMargin,
    initialMargin,
    marginRatio: ratio !== null ? Number(formatUnits(ratio, 16)) : 0,
    status,
    unrealizedPnL: null,
    notionalValue,
    oraclePriceX18: snap.indexPriceX18 ?? 0n,
  };
}

function logStaleTransitions(snapshot: CycleSnapshot): void {
  for (const [marketId, error] of snapshot.marketErrors) {
    if (staleMarkets.has(marketId)) continue;
    staleMarkets.add(marketId);
    const why = isStaleOracleError(error) ? 'stale oracle price' : errorMessage(error);
    console.warn(`⏭️  Market ${marketId.slice(0, 10)}... index unreadable (${why}) - its positions are skipped until it recovers`);
  }
  for (const marketId of [...staleMarkets]) {
    if (!snapshot.marketErrors.has(marketId)) {
      staleMarkets.delete(marketId);
      console.log(`✅ Market ${marketId.slice(0, 10)}... oracle readable again`);
    }
  }
}

function logMarketStatus(snapshot: CycleSnapshot): void {
  if (snapshot.markets.size === 0) return;
  console.log('--- Market status ---');
  for (const [marketId, snap] of snapshot.markets) {
    const meta = getCachedMarketMeta(marketId);
    const mark = snap.markPriceX18 !== null ? Number(formatUnits(snap.markPriceX18, 18)) : NaN;
    const band = meta?.bandBps === null ? 'none' : `${meta?.bandBps}bps`;
    if (snap.indexPriceX18 === null) {
      console.log(`${marketId.slice(0, 10)}...  oracle STALE  mark $${mark.toFixed(4)}  band ${band}`);
      continue;
    }
    const index = Number(formatUnits(snap.indexPriceX18, 18));
    const premium = index > 0 ? ((mark - index) / index) * 100 : 0;
    console.log(
      `${marketId.slice(0, 10)}...  oracle $${index.toFixed(4)}  mark $${mark.toFixed(4)}  premium ${premium.toFixed(3)}%  band ${band}${meta?.info.paused ? '  [PAUSED]' : ''}`
    );
  }
  console.log('---------------------');
}

/**
 * Funding accrues on every trade and liquidation, so pokes only matter for
 * markets with open interest and no trade for FUNDING_POKE_STALE_SEC.
 * pokeFundingSafely marks each attempt, so failures are not retried per cycle.
 */
async function maybePokeFunding(marketIds: string[], head: bigint): Promise<void> {
  const staleBlocks = BigInt(config.fundingPokeStaleSec) / SEPOLIA_BLOCK_SEC;
  for (const marketId of marketIds) {
    const lastTrade = getLastTradeBlock(marketId);
    if (lastTrade === undefined || head - lastTrade < staleBlocks) continue;
    const meta = getCachedMarketMeta(marketId);
    if (!meta || meta.info.paused) continue;
    if (await pokeFundingSafely(marketId as `0x${string}`, meta)) {
      console.log(`⏰ Funding poked for idle market ${marketId.slice(0, 10)}... (no trade for ${head - lastTrade} blocks)`);
    }
  }
}

export async function monitorPositions(): Promise<void> {
  state.cycle++;
  state.lastSyncedBlock = await syncPositions(state.head);

  const positions = getAllTrackedPositions();
  const marketIds = [...new Set(positions.map((p) => p.marketId.toLowerCase()))];
  if (marketIds.length > 0) await refreshMarketMeta(marketIds);

  // Always run, even with no positions: it is also how the head is learned
  // (Multicall3.getBlockNumber), which the getLogs fallback needs.
  const snapshot = await readCycleSnapshot(positions, marketIds);
  state.head = snapshot.blockNumber;
  logStaleTransitions(snapshot);

  if (Date.now() - state.lastMarketStatusAt > MARKET_STATUS_EVERY_MS) {
    state.lastMarketStatusAt = Date.now();
    logMarketStatus(snapshot);
  }

  const liquidatedMarkets = new Set<string>();
  let readErrors = 0;

  for (const tracked of positions) {
    const key = `${tracked.account.toLowerCase()}:${tracked.marketId.toLowerCase()}`;
    const marketId = tracked.marketId.toLowerCase();
    const read = snapshot.positions.get(key);
    const meta = getCachedMarketMeta(marketId);
    const snap = snapshot.markets.get(marketId);
    if (!read || !meta || !snap) continue;

    if (read.liquidatable === null) {
      if (!staleMarkets.has(marketId)) readErrors++;
      continue;
    }
    // Closed on-chain, not yet reflected by the source.
    if (read.marginRatioX18 === MAX_UINT) continue;

    const health = buildHealth(tracked, read, meta, snap);
    const previousStatus = tracked.healthStatus;
    updateTrackedPosition(tracked.account, tracked.marketId, { healthStatus: health.status, lastChecked: Date.now() });

    const alert: AlertData = {
      account: tracked.account,
      marketId: tracked.marketId,
      health,
      position: { size: tracked.size },
      timestamp: Date.now(),
    };

    if (health.status === HealthStatus.LIQUIDATABLE) {
      if (!config.executeMode) {
        if (previousStatus !== HealthStatus.LIQUIDATABLE) {
          console.log(`🚨 LIQUIDATABLE: ${tracked.account.slice(0, 10)}... in ${marketId.slice(0, 10)}...`);
        }
        await sendEmailAlert(alert);
        continue;
      }

      // Reserves read this cycle are stale once we have traded in this market.
      if (liquidatedMarkets.has(marketId)) continue;

      const outcome = await executeLiquidationSafely(tracked.account, tracked.marketId, tracked.size, meta, snap, state.cycle);
      if (outcome.status === 'backoff') continue;

      if (outcome.status === 'success') {
        liquidatedMarkets.add(marketId);
        if (outcome.full) {
          removePosition(tracked.account, tracked.marketId);
        } else {
          const remaining = tracked.size > 0n ? tracked.size - outcome.size : tracked.size + outcome.size;
          updateTrackedPosition(tracked.account, tracked.marketId, { size: remaining });
        }
        await sendEmailAlert({ ...alert, executionResult: 'success' });
      } else {
        console.log(`   ↪ ${tracked.account.slice(0, 10)}... ${outcome.status}: ${outcome.reason}`);
        await sendEmailAlert({ ...alert, executionResult: outcome.status === 'failed' ? 'failed' : 'skipped' });
      }
    } else if (health.status === HealthStatus.WARNING) {
      if (previousStatus !== HealthStatus.WARNING) {
        console.log(`⚠️  WARNING: ${tracked.account.slice(0, 10)}... margin below IMR`);
        await sendEmailAlert(alert);
      }
    } else if (previousStatus !== HealthStatus.SAFE) {
      console.log(`✅ ${tracked.account.slice(0, 10)}... recovered to SAFE`);
    }
  }

  if (readErrors > 0) console.warn(`⚠️  ${readErrors} position read(s) failed this cycle`);

  if (config.executeMode && config.fundingPokeEnabled) {
    await maybePokeFunding(marketIds, state.head);
  }

  const stats = getTrackerStats();
  console.log(
    `[${new Date().toISOString()}] cycle ${state.cycle} block ${state.head} source=${stats.source} ` +
      `positions=${stats.total} (${stats.safe} safe, ${stats.warning} warning, ${stats.liquidatable} liquidatable)`
  );
  if (config.executeMode && stats.liquidatable > 0) logExecutionStats();

  state.lastCycleAt = Date.now();
}

let monitoringInterval: NodeJS.Timeout | null = null;

export function startMonitoring(): void {
  if (monitoringInterval) {
    console.log('Monitoring already running');
    return;
  }

  console.log(`Starting monitor loop (every ${config.pollingIntervalMs}ms)`);

  // Never overlap cycles: two cycles could both decide to liquidate the same
  // position and the loser burns gas on a revert.
  let cycleInFlight = false;

  const runCycle = async () => {
    if (cycleInFlight) {
      console.log('Previous cycle still running - skipping this tick');
      return;
    }
    cycleInFlight = true;

    try {
      await monitorPositions();
      state.lastError = null;
    } catch (error: any) {
      // A cycle failure must not kill the loop.
      state.lastError = error.shortMessage || error.message || String(error);
      console.error(`Cycle error: ${state.lastError}`);
    } finally {
      cycleInFlight = false;
    }
  };

  void runCycle();
  monitoringInterval = setInterval(() => void runCycle(), config.pollingIntervalMs);
}

export function stopMonitoring(): void {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
    console.log('Monitoring stopped');
  }
}
