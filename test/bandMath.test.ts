import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WAD,
  bandCeilX18,
  bandEdgeAmountLimit,
  bandFloorX18,
  buyQuoteIn,
  fillPriceX18,
  fillWithinBand,
  maxSizeWithinBand,
  planLiquidationSize,
  sellQuoteOut,
  type PoolState,
} from '../src/bandMath';

const e18 = (n: number | bigint) => BigInt(n) * WAD;

// Pool at mark 2.00 with 1000 base of depth, 10 bps fee.
const pool: PoolState = { baseReserve: e18(1000), quoteReserve: e18(2000), feeBps: 10n };
const index = e18(2);
const band = 500n; // 5%

test('sell/buy formulas match the vAMM for a small trade', () => {
  const dx = e18(1);
  const out = sellQuoteOut(pool, dx);
  // Y*dx*f/(X*1e4 + dx*f) = 2000*1*9990/(1000*1e4 + 9990)
  assert.equal(out, (e18(2000) * dx * 9990n) / (e18(1000) * 10_000n + dx * 9990n));
  const gross = buyQuoteIn(pool, dx)!;
  assert.ok(gross > e18(2)); // pays above mark
  assert.equal(buyQuoteIn(pool, pool.baseReserve), null);
});

test('closing long: max size is the boundary of the band', () => {
  const max = maxSizeWithinBand(pool, true, e18(1000), index, band);
  assert.ok(max > 0n);
  assert.ok(fillWithinBand(pool, true, max, index, band));
  assert.ok(!fillWithinBand(pool, true, max + 1n, index, band));
  // Closed form (continuous): dx = Y/F - X*1e4/(1e4-f) = 2000/1.9 - 1000*1e4/9990 ≈ 51.6
  const approx = Number(max) / 1e18;
  assert.ok(approx > 51 && approx < 52.2, `got ${approx}`);
  const out = sellQuoteOut(pool, max);
  assert.ok(fillPriceX18(out, max) >= bandFloorX18(index, band));
});

test('closing short: max size is the boundary of the band', () => {
  const max = maxSizeWithinBand(pool, false, e18(1000), index, band);
  assert.ok(fillWithinBand(pool, false, max, index, band));
  assert.ok(!fillWithinBand(pool, false, max + 1n, index, band));
  // X - Y*1e4/((1e4-f)*C) = 1000 - 2000*1e4/(9990*2.1) ≈ 46.6
  const approx = Number(max) / 1e18;
  assert.ok(approx > 46 && approx < 47.2, `got ${approx}`);
  const gross = buyQuoteIn(pool, max)!;
  assert.ok(fillPriceX18(gross, max) <= bandCeilX18(index, band));
});

test('small positions close fully; no size when mark is already outside the band', () => {
  assert.equal(maxSizeWithinBand(pool, true, e18(10), index, band), e18(10));
  // Index far above mark: a long cannot be sold within 5% of it at any size.
  assert.equal(maxSizeWithinBand(pool, true, e18(10), e18(3), band), 0n);
  // Index far below mark: a short cannot be bought back within 5%.
  assert.equal(maxSizeWithinBand(pool, false, e18(10), e18(1), band), 0n);
});

test('fee is accounted for: zero-fee pool allows a larger size', () => {
  const noFee = { ...pool, feeBps: 0n };
  assert.ok(maxSizeWithinBand(noFee, true, e18(1000), index, band) > maxSizeWithinBand(pool, true, e18(1000), index, band));
});

test('planLiquidationSize: full / partial / minPositionSize handling', () => {
  const full = planLiquidationSize(pool, true, e18(10), index, band, e18(1));
  assert.deepEqual([full.size, full.full], [e18(10), true]);

  // 60 long, band allows ~51.6 -> remaining ~8.4 >= min 1 -> partial at the band size.
  const partial = planLiquidationSize(pool, true, e18(60), index, band, e18(1));
  assert.equal(partial.full, false);
  assert.equal(partial.size, maxSizeWithinBand(pool, true, e18(60), index, band));

  // 55 long, min 5: band size ~51.6 leaves ~3.4 < 5 -> shrink to 50 (leaves exactly min).
  const capped = planLiquidationSize(pool, true, e18(55), index, band, e18(5));
  assert.equal(capped.size, e18(50));
  assert.ok(fillWithinBand(pool, true, capped.size, index, band));

  // Position barely larger than min with full close out of band -> nothing valid.
  const none = planLiquidationSize(pool, true, e18(60), e18(3), band, e18(60));
  assert.equal(none.size, 0n);

  // minPositionSize = 0 means any partial is fine.
  const anyPartial = planLiquidationSize(pool, false, e18(500), index, band, 0n);
  assert.equal(anyPartial.size, maxSizeWithinBand(pool, false, e18(500), index, band));
});

test('amountLimit at the band edge implies the on-chain band check', () => {
  const size = maxSizeWithinBand(pool, true, e18(1000), index, band);
  const minOut = bandEdgeAmountLimit(true, size, index, band);
  assert.ok(sellQuoteOut(pool, size) >= minOut);
  // any quoteOut >= minOut passes the floor check
  assert.ok(fillPriceX18(minOut, size) >= bandFloorX18(index, band));

  const sSize = maxSizeWithinBand(pool, false, e18(1000), index, band);
  const maxIn = bandEdgeAmountLimit(false, sSize, index, band);
  assert.ok(buyQuoteIn(pool, sSize)! <= maxIn);
  assert.ok(fillPriceX18(maxIn, sSize) <= bandCeilX18(index, band));
});
