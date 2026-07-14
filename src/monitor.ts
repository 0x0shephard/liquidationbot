import { config } from './config';
import {
  calculateMarginHealth,
  getPosition,
  getMarket,
  getOraclePrice,
  getMarkPrice,
  isStaleOracleError,
} from './blockchain';
import {
  getAllTrackedPositions,
  updateTrackedPosition,
  removePosition,
  syncNewEvents,
  getTrackerStats,
} from './tracker';
import { sendEmailAlert } from './notifications';
import { executeLiquidationSafely, pokeFundingSafely, logExecutionStats } from './executor';
import { HealthStatus, AlertData } from './types';

// Funding is poked per-market, since each market has its own vAMM.
const lastFundingPokeByMarket = new Map<string, number>();

async function maybePokeFunding(marketIds: Set<string>): Promise<void> {
  const now = Date.now();

  for (const marketId of marketIds) {
    const last = lastFundingPokeByMarket.get(marketId) ?? 0;
    if (now - last < config.fundingPokeIntervalMs) continue;

    console.log(`\n⏰ Poking funding for ${marketId.slice(0, 10)}...`);
    if (await pokeFundingSafely(marketId as `0x${string}`)) {
      lastFundingPokeByMarket.set(marketId, now);
    }
  }
}

export async function monitorPositions(): Promise<void> {
  await syncNewEvents();

  const positions = getAllTrackedPositions();
  const stats = getTrackerStats();

  console.log(`\n[${new Date().toISOString()}] Checking ${positions.length} position(s)`);
  console.log(`  ${stats.safe} safe, ${stats.warning} warning, ${stats.liquidatable} liquidatable`);

  if (positions.length === 0) {
    console.log('No open positions');
    return;
  }

  if (config.executeMode) {
    await maybePokeFunding(new Set(positions.map((p) => p.marketId)));
  }

  let scanned = 0;
  const staleMarkets = new Set<string>();

  for (const tracked of positions) {
    if (scanned >= config.maxPositionsPerScan) {
      console.log(`Reached MAX_POSITIONS_PER_SCAN (${config.maxPositionsPerScan}) - remaining positions next cycle`);
      break;
    }
    scanned++;

    try {
      const position = await getPosition(tracked.account, tracked.marketId);

      // Closed or fully liquidated between our last sync and now.
      if (position.size === 0n) {
        removePosition(tracked.account, tracked.marketId);
        continue;
      }

      const health = await calculateMarginHealth(tracked.account, tracked.marketId, position);
      const previousStatus = tracked.healthStatus;

      updateTrackedPosition(tracked.account, tracked.marketId, {
        size: position.size,
        healthStatus: health.status,
        lastChecked: Date.now(),
      });

      const alert: AlertData = {
        account: tracked.account,
        marketId: tracked.marketId,
        health,
        position,
        timestamp: Date.now(),
      };

      if (health.status === HealthStatus.LIQUIDATABLE) {
        console.log(`🚨 LIQUIDATABLE: ${tracked.account.slice(0, 10)}... in ${tracked.marketId.slice(0, 10)}...`);

        if (config.executeMode) {
          const liquidated = await executeLiquidationSafely(tracked.account, tracked.marketId);
          if (liquidated) {
            removePosition(tracked.account, tracked.marketId);
            await sendEmailAlert({ ...alert, executionResult: 'success' });
          } else {
            await sendEmailAlert({ ...alert, executionResult: 'skipped' });
          }
        } else {
          await sendEmailAlert(alert);
        }
      } else if (health.status === HealthStatus.WARNING) {
        if (previousStatus !== HealthStatus.WARNING) {
          console.log(`⚠️  WARNING: ${tracked.account.slice(0, 10)}... margin below IMR`);
          await sendEmailAlert(alert);
        }
      } else if (previousStatus !== HealthStatus.SAFE) {
        console.log(`✅ ${tracked.account.slice(0, 10)}... recovered to SAFE`);
      }
    } catch (error: any) {
      // A stale oracle makes every position in that market unreadable, so report
      // it once per market per cycle instead of once per position.
      if (isStaleOracleError(error)) {
        if (!staleMarkets.has(tracked.marketId)) {
          staleMarkets.add(tracked.marketId);
          console.warn(
            `⏭️  Market ${tracked.marketId.slice(0, 10)}... has a stale oracle price - skipping until it is refreshed`
          );
        }
        continue;
      }
      console.error(`❌ Error checking ${tracked.account}: ${error.shortMessage || error.message}`);
    }
  }

  if (staleMarkets.size > 0) {
    console.warn(`⚠️  ${staleMarkets.size} market(s) skipped this cycle due to stale oracle prices.`);
  }

  if (config.executeMode) logExecutionStats();
}

let monitoringInterval: NodeJS.Timeout | null = null;

export function startMonitoring(): void {
  if (monitoringInterval) {
    console.log('Monitoring already running');
    return;
  }

  console.log(`Starting monitor loop (every ${config.pollingIntervalMs}ms)`);
  monitorPositions().catch(console.error);
  monitoringInterval = setInterval(() => {
    monitorPositions().catch(console.error);
  }, config.pollingIntervalMs);
}

export function stopMonitoring(): void {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
    console.log('Monitoring stopped');
  }
}

/** Log oracle vs mark price for each market we currently have exposure to. */
export async function logMarketStatus(marketIds: `0x${string}`[]): Promise<void> {
  if (marketIds.length === 0) return;

  console.log('\n--- Market status ---');
  for (const marketId of marketIds) {
    try {
      const market = await getMarket(marketId);
      const [oraclePrice, markPrice] = await Promise.all([
        getOraclePrice(market.oracle),
        getMarkPrice(market.vamm),
      ]);

      const oracleNum = Number(oraclePrice) / 1e18;
      const markNum = Number(markPrice) / 1e18;
      const premium = oracleNum > 0 ? ((markNum - oracleNum) / oracleNum) * 100 : 0;

      console.log(
        `${marketId.slice(0, 10)}...  oracle $${oracleNum.toFixed(4)}  mark $${markNum.toFixed(4)}  premium ${premium.toFixed(3)}%${market.paused ? '  [PAUSED]' : ''}`
      );
    } catch (error: any) {
      console.error(`${marketId.slice(0, 10)}...  error: ${error.shortMessage || error.message}`);
    }
  }
  console.log('---------------------\n');
}
