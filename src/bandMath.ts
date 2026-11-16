/**
 * Liquidation price-band math (pure, no I/O).
 *
 * ClearingHouse._checkLiquidationFill reverts LiquidationPriceOutOfBand when a
 * liquidation's vAMM fill is worse than the index by more than the market's band:
 *   closing a long  (sellBase): fill = quoteOut  * 1e18 / baseIn  must be >= index * (1e4 - band) / 1e4
 *   closing a short (buyBase):  fill = grossIn   * 1e18 / baseOut must be <= index * (1e4 + band) / 1e4
 * (fill is computed with a floor mulDiv on-chain.)
 *
 * The functions below mirror vAMM.sellBase / vAMM.buyBase integer math exactly
 * (constant product x*y=k with the fee taken on the input side), and binary-search
 * the largest size whose fill stays inside the band. The fill is monotonic in
 * size (bigger trade => worse average price), so the search is exact for the
 * reserves it is given. Reserves can move before the tx lands; amountLimit is set
 * to the band-edge quote amount so a moved pool reverts on "slippage" in the vAMM
 * instead of filling outside the band.
 */

export const WAD = 10n ** 18n;
export const BPS = 10_000n;

export interface PoolState {
  baseReserve: bigint; // X
  quoteReserve: bigint; // Y
  feeBps: bigint; // vAMM.feeBps (fee on input)
}

function mulDivUp(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b + d - 1n) / d;
}

/** quoteOut for vAMM.sellBase(dx) - closing a long. Ignores the minReserveQuote clamp. */
export function sellQuoteOut(pool: PoolState, dx: bigint): bigint {
  const f = BPS - pool.feeBps;
  const numerator = pool.quoteReserve * dx * f;
  const denominator = pool.baseReserve * BPS + dx * f;
  return numerator / denominator;
}

/** grossQuoteIn for vAMM.buyBase(dx) - closing a short. Returns null if dx >= X. */
export function buyQuoteIn(pool: PoolState, dx: bigint): bigint | null {
  if (dx >= pool.baseReserve) return null;
  const inWithFeeScaled = mulDivUp(dx, pool.quoteReserve * BPS, pool.baseReserve - dx);
  return mulDivUp(inWithFeeScaled, 1n, BPS - pool.feeBps);
}

/** On-chain fill price: floor(absQuote * 1e18 / absBase). */
export function fillPriceX18(absQuote: bigint, absBase: bigint): bigint {
  return (absQuote * WAD) / absBase;
}

export function bandFloorX18(indexX18: bigint, bandBps: bigint): bigint {
  return (indexX18 * (BPS - bandBps)) / BPS;
}

export function bandCeilX18(indexX18: bigint, bandBps: bigint): bigint {
  return (indexX18 * (BPS + bandBps)) / BPS;
}

/**
 * True when liquidating `dx` fills inside the band AND passes the band-edge
 * amountLimit we send (bandEdgeAmountLimit). For a long close the two are
 * equivalent; for a short close the amountLimit test is slightly stricter than
 * the on-chain floor(grossIn*1e18/dx) <= ceil check, so sizing against it
 * guarantees the vAMM slippage guard never rejects the chosen size.
 */
export function fillWithinBand(
  pool: PoolState,
  closingLong: boolean,
  dx: bigint,
  indexX18: bigint,
  bandBps: bigint
): boolean {
  if (dx <= 0n) return false;
  const limit = bandEdgeAmountLimit(closingLong, dx, indexX18, bandBps);
  if (closingLong) {
    const out = sellQuoteOut(pool, dx);
    return out > 0n && out >= limit;
  }
  const gross = buyQuoteIn(pool, dx);
  return gross !== null && gross <= limit;
}

/** Largest dx in [0, maxSize] whose fill is inside the band (0 if none). */
export function maxSizeWithinBand(
  pool: PoolState,
  closingLong: boolean,
  maxSize: bigint,
  indexX18: bigint,
  bandBps: bigint
): bigint {
  if (maxSize <= 0n || pool.baseReserve === 0n || pool.quoteReserve === 0n) return 0n;
  if (fillWithinBand(pool, closingLong, maxSize, indexX18, bandBps)) return maxSize;

  // Invariant: lo is valid (or 0), hi is invalid.
  let lo = 0n;
  let hi = maxSize;
  while (hi - lo > 1n) {
    const mid = lo + (hi - lo) / 2n;
    if (fillWithinBand(pool, closingLong, mid, indexX18, bandBps)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * amountLimit at the band edge for a liquidation of `size`:
 *  - closing a long:  minimum quote out = ceil(size * floor / 1e18)
 *  - closing a short: maximum quote in  = floor(size * ceil / 1e18)
 * Either bound implies the on-chain band check passes, so if the pool moved
 * against us the vAMM reverts "slippage" rather than filling outside the band.
 */
export function bandEdgeAmountLimit(
  closingLong: boolean,
  size: bigint,
  indexX18: bigint,
  bandBps: bigint
): bigint {
  return closingLong
    ? mulDivUp(size, bandFloorX18(indexX18, bandBps), WAD)
    : (size * bandCeilX18(indexX18, bandBps)) / WAD;
}

export interface LiquidationSizePlan {
  size: bigint; // 0 => nothing can be liquidated inside the band right now
  full: boolean;
  reason: string;
}

/**
 * Choose the liquidation size:
 *  1. the largest size inside the band, capped at the position;
 *  2. respect minPositionSize: a partial must leave >= minPositionSize behind
 *     (else RemainingBelowMinLiquidateFull). If the in-band size would leave
 *     dust, close fully only if the full close is inside the band; otherwise
 *     shrink to absSize - minPositionSize (still in band, since smaller fills
 *     better).
 */
export function planLiquidationSize(
  pool: PoolState,
  closingLong: boolean,
  absSize: bigint,
  indexX18: bigint,
  bandBps: bigint,
  minPositionSize: bigint
): LiquidationSizePlan {
  const inBand = maxSizeWithinBand(pool, closingLong, absSize, indexX18, bandBps);
  if (inBand === 0n) return { size: 0n, full: false, reason: 'no size fills inside the price band' };
  if (inBand >= absSize) return { size: absSize, full: true, reason: 'full close inside band' };

  const remaining = absSize - inBand;
  if (minPositionSize > 0n && remaining < minPositionSize) {
    // Full close is not in band (inBand < absSize), so take the largest partial
    // that leaves exactly minPositionSize.
    const partial = absSize - minPositionSize;
    if (partial <= 0n) {
      return { size: 0n, full: false, reason: 'position too small for a partial above minPositionSize, full close out of band' };
    }
    return { size: partial, full: false, reason: 'partial capped to leave minPositionSize' };
  }
  return { size: inBand, full: false, reason: 'partial limited by price band' };
}
