/**
 * Liquidation execution with profitability checks.
 *
 * The reward model mirrors ClearingHouse.liquidate: penalty is derived from the
 * pre-trade risk (oracle) price, rounded up, clamped by penaltyCap, and split
 * with the FeeRouter when one is configured.
 *
 * RPC budget per attempt: estimateFeesPerGas (2 calls), one eth_estimateGas
 * (the only execution of liquidate before sending - it doubles as the
 * simulation), then the send. Market data comes from the cycle multicall.
 * Every non-success is remembered per (account, market) and not retried until
 * the index or mark price moves by LIQ_BACKOFF_PRICE_BPS or LIQ_BACKOFF_CYCLES
 * cycles pass.
 */

import { formatUnits, parseGwei } from 'viem';
import { config } from './config';
import {
  estimateLiquidationGas,
  sendLiquidation,
  executePokeFunding,
  waitForTransaction,
  estimateFees,
  getLiquidatorAddress,
  hasFeeRouter,
  revertErrorName,
  errorMessage,
} from './blockchain';
import { bandEdgeAmountLimit, planLiquidationSize, WAD, BPS } from './bandMath';
import { MarketMeta, MarketSnapshot } from './types';

export interface ExecutionStats {
  attempted: number;
  successful: number;
  failed: number;
  skipped: number;
  backedOff: number;
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
  backedOff: 0,
  unprofitableExecutions: 0,
  totalRewardsUsd: 0,
  totalGasCostUsd: 0,
  lastLiquidationTime: null,
  lastFundingPokeTime: null,
};

export type LiquidationOutcome =
  | { status: 'success'; size: bigint; full: boolean }
  | { status: 'skipped' | 'failed' | 'backoff'; reason: string };

// ---------------------------------------------------------------------------
// Failure backoff
// ---------------------------------------------------------------------------

interface Backoff {
  cycle: number;
  index: bigint | null;
  mark: bigint | null;
  reason: string;
}
const backoff = new Map<string, Backoff>();

function bkey(account: string, marketId: string): string {
  return `${account.toLowerCase()}:${marketId.toLowerCase()}`;
}

function movedBeyond(prev: bigint | null, now: bigint | null): boolean {
  if (prev === null || now === null || prev === 0n) return prev !== now;
  const diff = now > prev ? now - prev : prev - now;
  return diff * BPS > prev * config.liqBackoffPriceBps;
}

/** Returns the reason if the position is still in backoff, else null. */
function inBackoff(key: string, cycle: number, snap: MarketSnapshot): string | null {
  const b = backoff.get(key);
  if (!b) return null;
  if (
    cycle - b.cycle >= config.liqBackoffCycles ||
    movedBeyond(b.index, snap.indexPriceX18) ||
    movedBeyond(b.mark, snap.markPriceX18)
  ) {
    backoff.delete(key);
    return null;
  }
  return b.reason;
}

function recordFailure(key: string, cycle: number, snap: MarketSnapshot, reason: string): void {
  backoff.set(key, { cycle, index: snap.indexPriceX18, mark: snap.markPriceX18, reason });
}

// ---------------------------------------------------------------------------
// Reward model
// ---------------------------------------------------------------------------

function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
  return (a * b + denominator - 1n) / denominator;
}

/** Liquidator's share of the penalty, in X18 quote units. Mirrors the contract. */
export function estimateRewardX18(meta: MarketMeta, riskPriceX18: bigint, liquidationSize: bigint): bigint {
  const notional = mulDivRoundingUp(liquidationSize, riskPriceX18, WAD);
  let penalty = mulDivRoundingUp(notional, meta.risk.liquidationPenaltyBps, BPS);
  if (meta.risk.penaltyCap > 0n && penalty > meta.risk.penaltyCap) penalty = meta.risk.penaltyCap;
  return hasFeeRouter(meta.info) ? penalty - penalty / 2n : penalty;
}

/** The quote token is a USD stablecoin, and quote amounts are X18-normalized. */
function quoteX18ToUsd(amount: bigint): number {
  return Number(formatUnits(amount, 18));
}

// ---------------------------------------------------------------------------
// Size and amountLimit
// ---------------------------------------------------------------------------

interface SizePlan {
  size: bigint;
  amountLimit: bigint;
  full: boolean;
  note: string;
}

function planSize(meta: MarketMeta, snap: MarketSnapshot, positionSize: bigint): SizePlan | { error: string } {
  const closingLong = positionSize > 0n;
  const absSize = closingLong ? positionSize : -positionSize;

  // Pre-upgrade ClearingHouse: no band. Full close, legacy amountLimit modes.
  if (meta.bandBps === null) {
    let amountLimit = 0n;
    if (config.amountLimitMode === 'mark' && snap.markPriceX18) {
      const notional = (absSize * snap.markPriceX18) / WAD;
      amountLimit = closingLong
        ? (notional * (BPS - config.slippageBps)) / BPS
        : (notional * (BPS + config.slippageBps)) / BPS;
    }
    return { size: absSize, amountLimit, full: true, note: 'no price band on this ClearingHouse' };
  }

  if (snap.indexPriceX18 === null) return { error: 'index price unavailable' };
  if (snap.baseReserve === null || snap.quoteReserve === null || meta.vammFeeBps === null) {
    return { error: 'vAMM reserves/fee unavailable - cannot size inside the band' };
  }

  const plan = planLiquidationSize(
    { baseReserve: snap.baseReserve, quoteReserve: snap.quoteReserve, feeBps: meta.vammFeeBps },
    closingLong,
    absSize,
    snap.indexPriceX18,
    meta.bandBps,
    meta.risk.minPositionSize
  );
  if (plan.size === 0n) return { error: plan.reason };

  return {
    size: plan.size,
    amountLimit: bandEdgeAmountLimit(closingLong, plan.size, snap.indexPriceX18, meta.bandBps),
    full: plan.full,
    note: `${plan.reason} (band ${meta.bandBps} bps)`,
  };
}

// ---------------------------------------------------------------------------
// Liquidation
// ---------------------------------------------------------------------------

/**
 * Liquidate a position the cycle multicall reported as liquidatable.
 * `positionSize` is the signed size from the position source.
 */
export async function executeLiquidationSafely(
  account: `0x${string}`,
  marketId: `0x${string}`,
  positionSize: bigint,
  meta: MarketMeta,
  snap: MarketSnapshot,
  cycle: number
): Promise<LiquidationOutcome> {
  const key = bkey(account, marketId);
  const waiting = inBackoff(key, cycle, snap);
  if (waiting) {
    stats.backedOff++;
    return { status: 'backoff', reason: waiting };
  }

  const fail = (status: 'skipped' | 'failed', reason: string): LiquidationOutcome => {
    recordFailure(key, cycle, snap, reason);
    if (status === 'skipped') stats.skipped++;
    else stats.failed++;
    return { status, reason };
  };

  const liquidator = getLiquidatorAddress();
  if (meta.info.paused) return fail('skipped', 'market paused');
  if (snap.indexPriceX18 === null) return fail('skipped', 'index price unavailable (stale oracle?)');

  const plan = planSize(meta, snap, positionSize);
  if ('error' in plan) {
    console.log(`🚧 ${account.slice(0, 10)}... in ${marketId.slice(0, 10)}...: ${plan.error} - backing off`);
    return fail('skipped', plan.error);
  }

  const absSize = positionSize < 0n ? -positionSize : positionSize;
  console.log(`\n🎯 Liquidation candidate`);
  console.log(`   Account:    ${account}`);
  console.log(`   Market:     ${marketId}`);
  console.log(`   Position:   ${formatUnits(absSize, 18)} (${positionSize > 0n ? 'LONG' : 'SHORT'})`);
  console.log(`   Liquidate:  ${formatUnits(plan.size, 18)}${plan.full ? ' (full)' : ' (partial)'} - ${plan.note}`);
  console.log(`   amountLimit ${formatUnits(plan.amountLimit, 18)} | index ${formatUnits(snap.indexPriceX18, 18)} | mark ${snap.markPriceX18 !== null ? formatUnits(snap.markPriceX18, 18) : 'n/a'}`);
  console.log(`   Liquidator: ${liquidator}`);

  // Fees: skip rather than send a tx that cannot be included at our cap.
  const fees = await estimateFees();
  const capWei = parseGwei(String(config.maxGasPriceGwei));
  if (fees.maxFeePerGas > capWei) {
    console.log(`⛽ maxFeePerGas ${formatUnits(fees.maxFeePerGas, 9)} gwei exceeds MAX_GAS_PRICE_GWEI ${config.maxGasPriceGwei} - skipping`);
    return fail('skipped', 'gas above cap');
  }
  const maxFeePerGas = fees.maxFeePerGas < capWei ? fees.maxFeePerGas : capWei;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas < maxFeePerGas ? fees.maxPriorityFeePerGas : maxFeePerGas;

  // The single pre-send execution: estimateGas simulates and prices in one go.
  let gasUnits: bigint;
  try {
    gasUnits = await estimateLiquidationGas(account, marketId, plan.size, plan.amountLimit);
  } catch (error: any) {
    const reason = explainRevert(error, liquidator);
    console.warn(`🚫 Simulation reverted: ${reason}`);
    return fail('skipped', reason);
  }
  // Funding accrues between estimate and inclusion; leave headroom.
  let gas = (gasUnits * 12n) / 10n;
  if (gas > config.gasLimit) gas = config.gasLimit;

  const rewardUsd = quoteX18ToUsd(estimateRewardX18(meta, snap.indexPriceX18, plan.size));
  const gasCostUsd = (Number(gasUnits) * Number(maxFeePerGas)) / 1e18 * config.ethPriceUsd;
  const netProfitUsd = rewardUsd - gasCostUsd;
  const profitable = netProfitUsd > config.minLiquidationRewardUsd;

  console.log(`💰 Profitability`);
  console.log(`   Expected reward:  $${rewardUsd.toFixed(2)}`);
  console.log(`   Est. gas cost:    $${gasCostUsd.toFixed(2)} (${gasUnits} units @ ≤${formatUnits(maxFeePerGas, 9)} gwei, ETH=$${config.ethPriceUsd})`);
  console.log(`   Net profit:       $${netProfitUsd.toFixed(2)}`);
  console.log(`   Profitable:       ${profitable ? '✅' : '❌'} (min $${config.minLiquidationRewardUsd})`);

  if (!profitable) {
    if (config.requireProfitable) return fail('skipped', 'not profitable');
    const verdict =
      netProfitUsd < 0
        ? `at a net LOSS of $${Math.abs(netProfitUsd).toFixed(2)}`
        : `for $${netProfitUsd.toFixed(2)}, below the $${config.minLiquidationRewardUsd} threshold`;
    console.log(`   ⚠️  REQUIRE_PROFITABLE=false - liquidating anyway ${verdict}`);
    if (netProfitUsd < 0) stats.unprofitableExecutions++;
  }

  if (config.dryRun) {
    console.log(`🔍 DRY RUN - simulation passed, would have sent this liquidation. Not sending.`);
    return fail('skipped', 'dry run');
  }

  stats.attempted++;
  try {
    const hash = await sendLiquidation({
      account,
      marketId,
      size: plan.size,
      amountLimit: plan.amountLimit,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    console.log(`📝 Sent: https://sepolia.etherscan.io/tx/${hash}`);

    const receipt = await waitForTransaction(hash);
    if (receipt.status === 'success') {
      stats.successful++;
      stats.totalRewardsUsd += rewardUsd;
      stats.totalGasCostUsd += (Number(receipt.gasUsed) * Number(receipt.effectiveGasPrice)) / 1e18 * config.ethPriceUsd;
      stats.lastLiquidationTime = new Date();
      backoff.delete(key);
      console.log(`✅ Liquidated in block ${receipt.blockNumber} (gas used: ${receipt.gasUsed})`);
      return { status: 'success', size: plan.size, full: plan.full };
    }

    console.log(`❌ Transaction reverted on-chain (block ${receipt.blockNumber})`);
    return fail('failed', 'reverted on-chain');
  } catch (error: any) {
    const reason = explainRevert(error, liquidator);
    console.error(`❌ Liquidation failed: ${reason}`);
    return fail('failed', reason);
  }
}

/** Human-readable reason for a liquidate() revert (custom errors are in the ABI). */
export function explainRevert(error: any, liquidator: string | null): string {
  const name = revertErrorName(error);
  const message = `${name ?? ''} ${errorMessage(error)}`;
  const args: readonly unknown[] | undefined = (() => {
    let e = error;
    for (let i = 0; e && i < 6; i++) {
      if (e?.data?.args) return e.data.args;
      e = e.cause;
    }
    return undefined;
  })();

  if (/LiquidationPriceOutOfBand/.test(message)) {
    const [fill, index] = (args ?? []) as bigint[];
    return fill !== undefined
      ? `LiquidationPriceOutOfBand: fill ${formatUnits(fill, 18)} vs index ${formatUnits(index, 18)} (vAMM too far from oracle for this size)`
      : 'LiquidationPriceOutOfBand (vAMM too far from oracle for this size)';
  }
  if (/CuOracleAdapter_PriceStale|0x4ffbfa58/i.test(message)) return 'oracle price stale (CuOracleAdapter_PriceStale)';
  if (/OraclePriceZero|OracleNotSet/.test(message)) return `oracle unavailable (${name})`;
  if (/NotLiquidatable/.test(message)) return 'NotLiquidatable (recovered or front-run)';
  if (/MustLiquidateMore/.test(message)) return 'MustLiquidateMore (partial size inside the band does not restore health)';
  if (/NotWhitelistedLiquidator|onlyWhitelistedLiquidator|not whitelisted/i.test(message)) {
    return `${liquidator} is not whitelisted - admin must call setWhitelistedLiquidator`;
  }
  if (/InvalidSize/.test(message)) return 'InvalidSize (tracked size no longer matches on-chain position)';
  if (/MarketNotActive/.test(message)) return 'MarketNotActive (paused or inactive)';
  if (/RemainingBelowMinLiquidateFull/.test(message)) return 'RemainingBelowMinLiquidateFull (partial would leave dust)';
  if (/slippage|SlippageExceeded/i.test(message)) return 'vAMM slippage guard hit (pool moved past the band edge since the read)';
  return name ? `${name}` : errorMessage(error);
}

// ---------------------------------------------------------------------------
// Funding pokes (opt-in)
// ---------------------------------------------------------------------------

const pokeAttemptedAt = new Map<string, number>();

/**
 * Poke funding for one market. Marks the attempt BEFORE sending, so a failure
 * is not retried until FUNDING_POKE_STALE_SEC passes again.
 */
export async function pokeFundingSafely(marketId: `0x${string}`, meta: MarketMeta): Promise<boolean> {
  const now = Date.now();
  const last = pokeAttemptedAt.get(marketId) ?? 0;
  if (now - last < config.fundingPokeStaleSec * 1000) return false;
  pokeAttemptedAt.set(marketId, now);

  if (config.dryRun) {
    console.log(`🔍 DRY RUN - skipping funding poke for ${marketId.slice(0, 10)}...`);
    return false;
  }

  try {
    const fees = await estimateFees();
    const capWei = parseGwei(String(config.maxGasPriceGwei));
    if (fees.maxFeePerGas > capWei) {
      console.log(`⛽ Gas above cap - skipping funding poke for ${marketId.slice(0, 10)}...`);
      return false;
    }
    const hash = await executePokeFunding(meta.info.vamm, fees);
    const receipt = await waitForTransaction(hash);
    if (receipt.status === 'success') {
      stats.lastFundingPokeTime = new Date();
      console.log(`✅ Funding poked for ${marketId.slice(0, 10)}... (block ${receipt.blockNumber})`);
      return true;
    }
    console.log(`❌ Funding poke reverted for ${marketId.slice(0, 10)}...`);
    return false;
  } catch (error: any) {
    console.error(`❌ Funding poke failed for ${marketId.slice(0, 10)}...: ${errorMessage(error)}`);
    return false;
  }
}

export function getExecutionStats(): ExecutionStats & { inBackoff: number } {
  return { ...stats, inBackoff: backoff.size };
}

export function logExecutionStats(): void {
  console.log(
    `📊 Execution: attempted ${stats.attempted}, ok ${stats.successful}, failed ${stats.failed}, ` +
      `skipped ${stats.skipped}, backoff-skips ${stats.backedOff}, in backoff ${backoff.size}`
  );
  if (stats.unprofitableExecutions > 0) {
    console.log(`   At a loss:  ${stats.unprofitableExecutions} (REQUIRE_PROFITABLE=false)`);
  }
  if (stats.successful > 0) {
    const net = stats.totalRewardsUsd - stats.totalGasCostUsd;
    console.log(
      `   Rewards $${stats.totalRewardsUsd.toFixed(2)}, gas $${stats.totalGasCostUsd.toFixed(2)}, net ${net >= 0 ? 'profit' : 'LOSS'} $${net.toFixed(2)}`
    );
  }
}
