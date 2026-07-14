/**
 * Liquidation execution with profitability checks.
 *
 * The reward model mirrors ClearingHouse.liquidate exactly: penalty is derived
 * from the pre-trade risk (oracle) price, rounded up, clamped by penaltyCap, and
 * split with the FeeRouter when one is configured. All of those inputs are read
 * from chain rather than assumed - getting any of them wrong silently turns a
 * profitable liquidation into a loss.
 */

import { formatUnits } from 'viem';
import { config } from './config';
import {
  getPosition,
  getRiskParams,
  getMarket,
  getOraclePrice,
  isLiquidatable,
  isMarketActive,
  computeAmountLimit,
  simulateLiquidation,
  estimateLiquidationGas,
  sendLiquidation,
  executePokeFunding,
  waitForTransaction,
  getGasPriceGwei,
  getLiquidatorAddress,
  hasFeeRouter,
} from './blockchain';

const WAD = 10n ** 18n;
const BPS = 10_000n;

export interface ExecutionStats {
  attempted: number;
  successful: number;
  failed: number;
  skipped: number;
  unprofitableExecutions: number;
  totalRewardsUsd: number;
  totalGasCostUsd: number;
  lastLiquidationTime: Date | null;
  lastFundingPokeTime: Date | null;
}

const stats: ExecutionStats = {
  attempted: 0,
  successful: 0,
  failed: 0,
  skipped: 0,
  unprofitableExecutions: 0,
  totalRewardsUsd: 0,
  totalGasCostUsd: 0,
  lastLiquidationTime: null,
  lastFundingPokeTime: null,
};

function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
  return (a * b + denominator - 1n) / denominator;
}

/**
 * Liquidator's share of the penalty, in X18 quote units.
 * Mirrors the contract; notably penaltyCap can clamp this to near-zero, which is
 * why the cap is read rather than assumed.
 */
export async function estimateRewardX18(
  marketId: `0x${string}`,
  liquidationSize: bigint
): Promise<bigint> {
  const market = await getMarket(marketId);
  const [params, riskPriceX18] = await Promise.all([
    getRiskParams(marketId),
    getOraclePrice(market.oracle),
  ]);

  const notional = mulDivRoundingUp(liquidationSize, riskPriceX18, WAD);
  let penalty = mulDivRoundingUp(notional, params.liquidationPenaltyBps, BPS);
  if (params.penaltyCap > 0n && penalty > params.penaltyCap) {
    penalty = params.penaltyCap;
  }

  // FeeRouter present => protocol takes half.
  return hasFeeRouter(market) ? penalty - penalty / 2n : penalty;
}

/** The quote token is a USD stablecoin, and quote amounts are X18-normalized. */
function quoteX18ToUsd(amount: bigint): number {
  return Number(formatUnits(amount, 18));
}

/**
 * Liquidate a position. Returns true only when a transaction actually landed
 * on-chain successfully.
 */
export async function executeLiquidationSafely(
  account: `0x${string}`,
  marketId: `0x${string}`
): Promise<boolean> {
  const liquidator = getLiquidatorAddress();

  // Re-read size from chain. The tracker's copy is a cache and the contract
  // requires 0 < size <= current absSize, so a stale size reverts as InvalidSize.
  const position = await getPosition(account, marketId);
  if (position.size === 0n) return false;

  if (!(await isMarketActive(marketId))) {
    console.log(`⏸️  Market ${marketId.slice(0, 10)}... is not active - skipping`);
    return false;
  }

  // Re-check against the chain: another liquidator may have front-run us, or a
  // price move may have restored the position.
  if (!(await isLiquidatable(account, marketId))) {
    console.log(`↩️  ${account.slice(0, 10)}... no longer liquidatable - skipping`);
    return false;
  }

  const liquidationSize = position.size < 0n ? -position.size : position.size;

  console.log(`\n🎯 Liquidation candidate`);
  console.log(`   Account:    ${account}`);
  console.log(`   Market:     ${marketId}`);
  console.log(`   Size:       ${formatUnits(liquidationSize, 18)} (${position.size > 0n ? 'LONG' : 'SHORT'})`);
  console.log(`   Liquidator: ${liquidator}`);

  const gasPriceGwei = await getGasPriceGwei();
  if (gasPriceGwei > config.maxGasPriceGwei) {
    console.log(`⛽ Gas price ${gasPriceGwei.toFixed(2)} gwei exceeds max ${config.maxGasPriceGwei} - skipping`);
    stats.skipped++;
    return false;
  }

  const amountLimit = await computeAmountLimit(marketId, position.size, liquidationSize);

  // Simulate before costing: it both catches reverts early and yields the gas
  // number the profitability check needs.
  let request;
  try {
    request = await simulateLiquidation(account, marketId, liquidationSize, amountLimit);
  } catch (error: any) {
    console.warn(`🚫 Simulation reverted: ${error.shortMessage || error.message}`);
    explainRevert(error, liquidator);
    stats.skipped++;
    return false;
  }

  const rewardX18 = await estimateRewardX18(marketId, liquidationSize);
  const rewardUsd = quoteX18ToUsd(rewardX18);

  // simulateContract leaves request.gas undefined, so estimate explicitly.
  // Costing at GAS_LIMIT instead would overstate gas several-fold and reject
  // liquidations that are actually profitable.
  const gasUnits = await estimateLiquidationGas(account, marketId, liquidationSize, amountLimit);
  const gasCostEth = (Number(gasUnits) * gasPriceGwei) / 1e9;
  const gasCostUsd = gasCostEth * config.ethPriceUsd;
  const netProfitUsd = rewardUsd - gasCostUsd;
  const profitable = netProfitUsd > config.minLiquidationRewardUsd;

  console.log(`💰 Profitability`);
  console.log(`   Expected reward:  $${rewardUsd.toFixed(2)}`);
  console.log(`   Est. gas cost:    $${gasCostUsd.toFixed(2)} (${gasUnits} units @ ${gasPriceGwei.toFixed(2)} gwei, ETH=$${config.ethPriceUsd})`);
  console.log(`   Net profit:       $${netProfitUsd.toFixed(2)}`);
  console.log(`   Minimum required: $${config.minLiquidationRewardUsd}`);
  console.log(`   Profitable:       ${profitable ? '✅' : '❌'}`);

  if (!profitable) {
    if (config.requireProfitable) {
      stats.skipped++;
      return false;
    }

    // "Not profitable" means "did not clear the threshold", which is not the
    // same as losing money - say which one it actually is.
    const verdict =
      netProfitUsd < 0
        ? `at a net LOSS of $${Math.abs(netProfitUsd).toFixed(2)}`
        : `for $${netProfitUsd.toFixed(2)}, below the $${config.minLiquidationRewardUsd} threshold`;
    console.log(`   ⚠️  REQUIRE_PROFITABLE=false - liquidating anyway ${verdict}`);

    if (netProfitUsd < 0) stats.unprofitableExecutions++;
  }

  if (config.dryRun) {
    console.log(`🔍 DRY RUN - simulation passed, would have sent this liquidation. Not sending.`);
    stats.skipped++;
    return false;
  }

  stats.attempted++;

  try {
    const hash = await sendLiquidation(request);
    console.log(`📝 Sent: https://sepolia.etherscan.io/tx/${hash}`);

    const receipt = await waitForTransaction(hash);
    if (receipt.status === 'success') {
      stats.successful++;
      stats.totalRewardsUsd += rewardUsd;
      stats.totalGasCostUsd += (Number(receipt.gasUsed) * gasPriceGwei) / 1e9 * config.ethPriceUsd;
      stats.lastLiquidationTime = new Date();
      console.log(`✅ Liquidated in block ${receipt.blockNumber} (gas used: ${receipt.gasUsed})`);
      return true;
    }

    stats.failed++;
    console.log(`❌ Transaction reverted on-chain (block ${receipt.blockNumber})`);
    return false;
  } catch (error: any) {
    stats.failed++;
    console.error(`❌ Liquidation failed: ${error.shortMessage || error.message}`);
    explainRevert(error, liquidator);
    return false;
  }
}

// The ClearingHouse reverts with custom errors, so match on those names.
function explainRevert(error: any, liquidator: string | null): void {
  const message = `${error?.shortMessage ?? ''} ${error?.message ?? ''}`;

  if (/NotLiquidatable/i.test(message)) {
    console.log(`   Position is no longer liquidatable (likely front-run).`);
  } else if (/onlyWhitelistedLiquidator|not whitelisted/i.test(message)) {
    console.log(`   ⚠️  ${liquidator} is not whitelisted. Admin must call setWhitelistedLiquidator.`);
  } else if (/InvalidSize/i.test(message)) {
    console.log(`   Size no longer matches the on-chain position.`);
  } else if (/MarketNotActive/i.test(message)) {
    console.log(`   Market is paused or inactive.`);
  } else if (/RemainingBelowMinLiquidateFull/i.test(message)) {
    console.log(`   Partial liquidation would leave dust below minPositionSize.`);
  } else if (/SlippageExceeded|amountLimit/i.test(message)) {
    console.log(`   amountLimit too tight - raise SLIPPAGE_BPS or set AMOUNT_LIMIT_MODE=zero.`);
  }
}

export async function pokeFundingSafely(marketId: `0x${string}`): Promise<boolean> {
  const gasPriceGwei = await getGasPriceGwei();
  if (gasPriceGwei > config.maxGasPriceGwei) {
    console.log(`⛽ Gas price too high (${gasPriceGwei.toFixed(2)} gwei) - skipping funding poke`);
    return false;
  }

  if (config.dryRun) {
    console.log(`🔍 DRY RUN - skipping funding poke for ${marketId.slice(0, 10)}...`);
    return false;
  }

  try {
    const hash = await executePokeFunding(marketId);
    const receipt = await waitForTransaction(hash);

    if (receipt.status === 'success') {
      stats.lastFundingPokeTime = new Date();
      console.log(`✅ Funding poked for ${marketId.slice(0, 10)}... (block ${receipt.blockNumber})`);
      return true;
    }

    console.log(`❌ Funding poke reverted for ${marketId.slice(0, 10)}...`);
    return false;
  } catch (error: any) {
    console.error(`❌ Funding poke failed: ${error.shortMessage || error.message}`);
    return false;
  }
}

export function getExecutionStats(): ExecutionStats {
  return { ...stats };
}

export function logExecutionStats(): void {
  console.log(`\n📊 Execution stats`);
  console.log(`   Attempted:  ${stats.attempted}`);
  console.log(`   Successful: ${stats.successful}`);
  console.log(`   Failed:     ${stats.failed}`);
  console.log(`   Skipped:    ${stats.skipped}`);

  if (stats.unprofitableExecutions > 0) {
    console.log(`   At a loss:  ${stats.unprofitableExecutions} (REQUIRE_PROFITABLE=false)`);
  }

  if (stats.successful > 0) {
    const net = stats.totalRewardsUsd - stats.totalGasCostUsd;
    console.log(`   Rewards:    $${stats.totalRewardsUsd.toFixed(2)}`);
    console.log(`   Gas costs:  $${stats.totalGasCostUsd.toFixed(2)}`);
    console.log(`   Net ${net >= 0 ? 'profit' : 'LOSS  '}: $${net.toFixed(2)}`);
  }
  if (stats.lastLiquidationTime) {
    console.log(`   Last liquidation: ${stats.lastLiquidationTime.toISOString()}`);
  }
  if (stats.lastFundingPokeTime) {
    console.log(`   Last funding poke: ${stats.lastFundingPokeTime.toISOString()}`);
  }
}
