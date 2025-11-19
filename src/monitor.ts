import { config } from './config';
import { calculateMarginHealth, getMarkPrice, getOraclePrice } from './blockchain';
import { getAllTrackedPositions, updateTrackedPosition, syncNewEvents, getTrackerStats } from './tracker';
import { sendEmailAlert, logAlert } from './notifications';
import { executeLiquidationSafely, pokeFundingSafely, logExecutionStats } from './executor';
import { HealthStatus, AlertData } from './types';

// Track last funding poke time
let lastFundingPokeTime = 0;

// Monitor all tracked positions
export async function monitorPositions(): Promise<void> {
  // First sync any new events
  await syncNewEvents();

  const positions = getAllTrackedPositions();
  const stats = getTrackerStats();

  console.log(`\n[${new Date().toISOString()}] Monitoring ${positions.length} positions...`);
  console.log(`Status: ${stats.safe} safe, ${stats.warning} warning, ${stats.liquidatable} liquidatable`);

  // Poke funding periodically if execution mode is enabled
  if (config.executeMode) {
    const now = Date.now();
    if (now - lastFundingPokeTime >= config.fundingPokeIntervalMs) {
      console.log(`\n⏰ Time to poke funding (${config.fundingPokeIntervalMs / 60000} minutes elapsed)`);
      const success = await pokeFundingSafely();
      if (success) {
        lastFundingPokeTime = now;
      }
    }
  }

  if (positions.length === 0) {
    console.log('No positions to monitor');
    return;
  }

  // Get current market data
  const [markPrice, oraclePrice] = await Promise.all([
    getMarkPrice(),
    getOraclePrice('ETH'),
  ]);

  console.log(`Mark Price: $${Number(markPrice) / 1e18}`);
  console.log(`Oracle Price: $${Number(oraclePrice) / 1e18}`);

  // Check each position
  for (const tracked of positions) {
    try {
      const health = await calculateMarginHealth(tracked.account, tracked.marketId);

      // Update tracked position
      updateTrackedPosition(tracked.account, tracked.marketId, {
        healthStatus: health.status,
        lastChecked: Date.now(),
      });

      // Check if alert needed
      const alertData: AlertData = {
        account: tracked.account,
        marketId: tracked.marketId,
        health,
        position: tracked.position,
        markPrice,
        timestamp: Date.now(),
      };

      // Handle LIQUIDATABLE positions
      if (health.status === HealthStatus.LIQUIDATABLE) {
        console.log(`🚨 LIQUIDATABLE position found: ${tracked.account.slice(0, 10)}...`);

        // Execute liquidation if in execution mode
        if (config.executeMode) {
          const success = await executeLiquidationSafely(
            tracked.account,
            tracked.marketId,
            tracked,
            health
          );

          if (success) {
            console.log(`✅ Liquidation executed successfully`);
            // Send success notification
            await sendEmailAlert({
              ...alertData,
              executionResult: 'success',
            });
          } else {
            console.log(`❌ Liquidation failed or skipped (not profitable)`);
          }
        } else {
          // Monitoring mode - just send alert
          console.log(`👁️  Monitoring mode - sending alert only`);
          await sendEmailAlert(alertData);
        }
      }
      // Handle WARNING positions
      else if (health.status === HealthStatus.WARNING) {
        // Check if status changed
        const statusChanged = tracked.healthStatus !== health.status;

        if (statusChanged) {
          console.log(`⚠️  WARNING: ${tracked.account.slice(0, 10)}... - margin running low`);
          await sendEmailAlert(alertData);
        } else {
          console.log(`⚠️  Position ${tracked.account.slice(0, 10)}... still in WARNING status`);
        }
      }
      // Position recovered
      else if (tracked.healthStatus !== HealthStatus.SAFE && health.status === HealthStatus.SAFE) {
        console.log(`✅ Position ${tracked.account.slice(0, 10)}... recovered to SAFE status`);
      }
    } catch (error) {
      console.error(`❌ Error checking position for ${tracked.account}:`, error);
    }
  }

  // Log execution stats if in execution mode
  if (config.executeMode) {
    logExecutionStats();
  }
}

// Start the monitoring loop
let monitoringInterval: NodeJS.Timeout | null = null;

export function startMonitoring(): void {
  if (monitoringInterval) {
    console.log('Monitoring already running');
    return;
  }

  console.log(`Starting monitoring loop (interval: ${config.pollingIntervalMs}ms)...`);

  // Run immediately
  monitorPositions().catch(console.error);

  // Then run on interval
  monitoringInterval = setInterval(() => {
    monitorPositions().catch(console.error);
  }, config.pollingIntervalMs);

  console.log('Monitoring started');
}

export function stopMonitoring(): void {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
    console.log('Monitoring stopped');
  }
}

// Price monitoring for market overview
export async function logMarketStatus(): Promise<void> {
  try {
    const [markPrice, oraclePrice] = await Promise.all([
      getMarkPrice(),
      getOraclePrice('ETH'),
    ]);

    const markPriceNum = Number(markPrice) / 1e18;
    const oraclePriceNum = Number(oraclePrice) / 1e18;
    const premium = ((markPriceNum - oraclePriceNum) / oraclePriceNum) * 100;

    console.log('\n--- Market Status ---');
    console.log(`Mark Price: $${markPriceNum.toFixed(4)}`);
    console.log(`Oracle Price: $${oraclePriceNum.toFixed(4)}`);
    console.log(`Premium: ${premium.toFixed(4)}%`);
    console.log('--------------------\n');
  } catch (error) {
    console.error('Error fetching market status:', error);
  }
}
