/**
 * Liquidation Executor Module
 * Handles execution of liquidations and funding pokes with profitability checks
 */

import { config } from './config';
import {
  executeLiquidation,
  executePokeFunding,
  waitForTransaction,
  getGasPrice,
  estimateLiquidationGas,
  getLiquidatorAddress,
  getMarkPrice,
} from './blockchain';
import { TrackedPosition, MarginHealth } from './types';

// Execution statistics
export interface ExecutionStats {
  totalLiquidations: number;
  successfulLiquidations: number;
  failedLiquidations: number;
  totalRewardsUsd: number;
  totalGasCostUsd: number;
  lastLiquidationTime: Date | null;
  lastFundingPokeTime: Date | null;
}

const stats: ExecutionStats = {
  totalLiquidations: 0,
  successfulLiquidations: 0,
  failedLiquidations: 0,
  totalRewardsUsd: 0,
  totalGasCostUsd: 0,
  lastLiquidationTime: null,
  lastFundingPokeTime: null,
};

/**
 * Calculate expected liquidation reward in USD
 * @param position Position data
 * @param health Margin health data
 * @param markPrice Current mark price
 * @returns Expected reward in USD
 */
function calculateExpectedReward(
  position: TrackedPosition,
  health: MarginHealth,
  markPrice: bigint
): number {
  // Calculate notional value
  const absSize = health.notionalValue;

  // Penalty is typically 2% of notional (200 bps)
  // Liquidator gets 50% of penalty (1% of notional)
  const penaltyBps = 200; // 2%
  const liquidatorShare = 0.5; // 50% of penalty

  const notionalUsd = Number(absSize) / 1e18;
  const penalty = notionalUsd * (penaltyBps / 10000);
  const liquidatorReward = penalty * liquidatorShare;

  return liquidatorReward;
}

/**
 * Check if liquidation is profitable after gas costs
 * @param account Account to liquidate
 * @param marketId Market ID
 * @param position Position data
 * @param health Margin health
 * @returns true if profitable, false otherwise
 */
export async function isProfitable(
  account: `0x${string}`,
  marketId: `0x${string}`,
  position: TrackedPosition,
  health: MarginHealth
): Promise<{ profitable: boolean; expectedRewardUsd: number; estimatedGasCostUsd: number }> {
  try {
    const markPrice = await getMarkPrice();
    const expectedRewardUsd = calculateExpectedReward(position, health, markPrice);

    // Get current gas price
    const gasPriceGwei = await getGasPrice();

    // Check if gas price is acceptable
    if (gasPriceGwei > config.maxGasPriceGwei) {
      console.log(`⛽ Gas price too high: ${gasPriceGwei.toFixed(2)} gwei (max: ${config.maxGasPriceGwei})`);
      return { profitable: false, expectedRewardUsd, estimatedGasCostUsd: 0 };
    }

    // Estimate gas cost
    const absSize = position.position.size < 0n ? -position.position.size : position.position.size;
    const gasUnits = await estimateLiquidationGas(account, marketId, absSize);

    // Calculate gas cost in USD (assuming ETH price from mark price)
    const ethPriceUsd = Number(markPrice) / 1e18;
    const gasCostEth = (Number(gasUnits) * gasPriceGwei) / 1e9;
    const gasCostUsd = gasCostEth * ethPriceUsd;

    // Check profitability
    const netProfit = expectedRewardUsd - gasCostUsd;
    const profitable = netProfit > config.minLiquidationRewardUsd;

    console.log(`💰 Profitability check:`);
    console.log(`   Expected reward: $${expectedRewardUsd.toFixed(2)}`);
    console.log(`   Estimated gas cost: $${gasCostUsd.toFixed(2)}`);
    console.log(`   Net profit: $${netProfit.toFixed(2)}`);
    console.log(`   Minimum required: $${config.minLiquidationRewardUsd}`);
    console.log(`   Profitable: ${profitable ? '✅' : '❌'}`);

    return { profitable, expectedRewardUsd, estimatedGasCostUsd: gasCostUsd };
  } catch (error) {
    console.error(`❌ Error checking profitability:`, error);
    return { profitable: false, expectedRewardUsd: 0, estimatedGasCostUsd: 0 };
  }
}

/**
 * Execute a liquidation with safety checks
 * @param account Account to liquidate
 * @param marketId Market ID
 * @param position Position data
 * @param health Margin health
 */
export async function executeLiquidationSafely(
  account: `0x${string}`,
  marketId: `0x${string}`,
  position: TrackedPosition,
  health: MarginHealth
): Promise<boolean> {
  const liquidatorAddress = getLiquidatorAddress();

  console.log(`\n🎯 Attempting liquidation:`);
  console.log(`   Account: ${account}`);
  console.log(`   Market: ${marketId}`);
  console.log(`   Position size: ${position.position.size}`);
  console.log(`   Liquidator: ${liquidatorAddress}`);

  // Dry run mode - simulate but don't execute
  if (config.dryRun) {
    console.log(`🔍 DRY RUN MODE - Skipping actual execution`);
    stats.totalLiquidations++;
    stats.successfulLiquidations++;
    stats.lastLiquidationTime = new Date();
    return true;
  }

  // Check profitability
  const { profitable, expectedRewardUsd, estimatedGasCostUsd } = await isProfitable(
    account,
    marketId,
    position,
    health
  );

  if (!profitable) {
    console.log(`❌ Liquidation not profitable - skipping`);
    return false;
  }

  try {
    stats.totalLiquidations++;

    // Execute liquidation
    const absSize = position.position.size < 0n ? -position.position.size : position.position.size;
    console.log(`⚡ Executing liquidation transaction...`);

    const hash = await executeLiquidation(account, marketId, absSize);
    console.log(`📝 Transaction sent: ${hash}`);
    console.log(`   View on Etherscan: https://sepolia.etherscan.io/tx/${hash}`);

    // Wait for confirmation
    console.log(`⏳ Waiting for confirmation...`);
    const receipt = await waitForTransaction(hash);

    if (receipt.status === 'success') {
      stats.successfulLiquidations++;
      stats.totalRewardsUsd += expectedRewardUsd;
      stats.totalGasCostUsd += estimatedGasCostUsd;
      stats.lastLiquidationTime = new Date();

      console.log(`✅ Liquidation successful!`);
      console.log(`   Block: ${receipt.blockNumber}`);
      console.log(`   Gas used: ${receipt.gasUsed}`);
      console.log(`   Estimated reward: $${expectedRewardUsd.toFixed(2)}`);

      return true;
    } else {
      stats.failedLiquidations++;
      console.log(`❌ Liquidation transaction failed`);
      return false;
    }
  } catch (error: any) {
    stats.failedLiquidations++;
    console.error(`❌ Liquidation execution failed:`, error.message || error);

    // Check if it's a known error
    if (error.message?.includes('Not liquidatable')) {
      console.log(`   Reason: Position is no longer liquidatable (front-run?)`);
    } else if (error.message?.includes('Caller is not a whitelisted liquidator')) {
      console.log(`   Reason: Liquidator address not whitelisted!`);
      console.log(`   ⚠️  You need to whitelist ${liquidatorAddress} as a liquidator`);
    }

    return false;
  }
}

/**
 * Poke funding rate update
 * @returns true if successful
 */
export async function pokeFundingSafely(): Promise<boolean> {
  console.log(`\n🔄 Poking funding rate...`);

  if (config.dryRun) {
    console.log(`🔍 DRY RUN MODE - Skipping actual execution`);
    stats.lastFundingPokeTime = new Date();
    return true;
  }

  try {
    const gasPriceGwei = await getGasPrice();

    if (gasPriceGwei > config.maxGasPriceGwei) {
      console.log(`⛽ Gas price too high: ${gasPriceGwei.toFixed(2)} gwei - skipping`);
      return false;
    }

    console.log(`⚡ Executing pokeFunding transaction...`);
    const hash = await executePokeFunding();
    console.log(`📝 Transaction sent: ${hash}`);

    console.log(`⏳ Waiting for confirmation...`);
    const receipt = await waitForTransaction(hash);

    if (receipt.status === 'success') {
      stats.lastFundingPokeTime = new Date();
      console.log(`✅ Funding poke successful!`);
      console.log(`   Block: ${receipt.blockNumber}`);
      return true;
    } else {
      console.log(`❌ Funding poke transaction failed`);
      return false;
    }
  } catch (error: any) {
    console.error(`❌ Funding poke failed:`, error.message || error);
    return false;
  }
}

/**
 * Get execution statistics
 */
export function getExecutionStats(): ExecutionStats {
  return { ...stats };
}

/**
 * Log execution statistics
 */
export function logExecutionStats(): void {
  console.log(`\n📊 Execution Statistics:`);
  console.log(`   Total liquidations attempted: ${stats.totalLiquidations}`);
  console.log(`   Successful: ${stats.successfulLiquidations}`);
  console.log(`   Failed: ${stats.failedLiquidations}`);
  if (stats.successfulLiquidations > 0) {
    console.log(`   Total rewards: $${stats.totalRewardsUsd.toFixed(2)}`);
    console.log(`   Total gas costs: $${stats.totalGasCostUsd.toFixed(2)}`);
    console.log(`   Net profit: $${(stats.totalRewardsUsd - stats.totalGasCostUsd).toFixed(2)}`);
  }
  if (stats.lastLiquidationTime) {
    console.log(`   Last liquidation: ${stats.lastLiquidationTime.toLocaleString()}`);
  }
  if (stats.lastFundingPokeTime) {
    console.log(`   Last funding poke: ${stats.lastFundingPokeTime.toLocaleString()}`);
  }
}
