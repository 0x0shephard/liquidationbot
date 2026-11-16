import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatUnits } from 'viem';
import { parseNewSize, latestSizes, openPositions, rowSize, type PnlEventRow } from '../src/supabaseRows';

test('parseNewSize round-trips formatUnits(x, 18)', () => {
  const values = [0n, 1n, -1n, 10n ** 18n, -(10n ** 18n), 1_500_000_000_000_000_000n, -123_456_789_012_345_678_901n, 2n ** 200n];
  for (const v of values) {
    assert.equal(parseNewSize(formatUnits(v, 18)), v, `value ${v}`);
  }
});

test('parseNewSize accepts Postgres numeric text forms', () => {
  assert.equal(parseNewSize('1.500000000000000000'), 1_500_000_000_000_000_000n);
  assert.equal(parseNewSize('-0.000000000000000001'), -1n);
  assert.equal(parseNewSize('0'), 0n);
  assert.equal(parseNewSize('-2'), -2n * 10n ** 18n);
  assert.equal(parseNewSize('.5'), 5n * 10n ** 17n);
  assert.equal(parseNewSize('1.0000000000000000010000'), 10n ** 18n + 1n); // trailing zeros past 18dp
  assert.equal(parseNewSize(1.5), 1_500_000_000_000_000_000n); // JSON number fallback
  assert.equal(parseNewSize('1e-18'), 1n);
  assert.equal(parseNewSize('-2.5E3'), -2500n * 10n ** 18n);
});

test('parseNewSize rejects garbage and silent rounding', () => {
  assert.throws(() => parseNewSize('abc'));
  assert.throws(() => parseNewSize(''));
  assert.throws(() => parseNewSize('1.0000000000000000001')); // 19th decimal non-zero
});

function row(p: Partial<PnlEventRow>): PnlEventRow {
  return {
    user_address: '0xAAA',
    market_id: '0xM1',
    accounting_type: 'open',
    block_number: '100',
    transaction_index: 0,
    primary_log_index: 0,
    new_size: null,
    ...p,
  };
}

test('rowSize: close with null new_size is flat; margin rows carry no size', () => {
  assert.equal(rowSize(row({ accounting_type: 'close', new_size: null })), 0n);
  assert.equal(rowSize(row({ accounting_type: 'margin_added', new_size: null })), undefined);
  assert.equal(rowSize(row({ accounting_type: 'increase', new_size: '-3' })), -3n * 10n ** 18n);
});

test('latestSizes picks the latest row by (block, txIndex, logIndex) regardless of input order', () => {
  const rows = [
    row({ block_number: '101', transaction_index: 2, primary_log_index: 9, new_size: '3', accounting_type: 'increase' }),
    row({ block_number: '100', new_size: '1' }),
    row({ block_number: '101', transaction_index: 2, primary_log_index: 4, new_size: '2', accounting_type: 'increase' }),
    row({ block_number: '101', transaction_index: 1, primary_log_index: 50, new_size: '9', accounting_type: 'increase' }),
    row({ block_number: '102', accounting_type: 'margin_added', new_size: null }), // ignored
  ];
  const m = latestSizes(rows);
  assert.equal(m.size, 1);
  const u = m.get('0xaaa:0xm1')!;
  assert.equal(u.size, 3n * 10n ** 18n);
  assert.equal(u.blockNumber, 101n);
  assert.equal(u.account, '0xaaa');
});

test('openPositions drops closed / liquidated-to-zero and honours the market filter', () => {
  const rows = [
    row({ user_address: '0xA', market_id: '0xM1', block_number: '1', new_size: '5' }),
    row({ user_address: '0xA', market_id: '0xM1', block_number: '2', accounting_type: 'close', new_size: null }),
    row({ user_address: '0xB', market_id: '0xM1', block_number: '1', new_size: '-4' }),
    row({ user_address: '0xB', market_id: '0xM1', block_number: '3', accounting_type: 'liquidation', new_size: '-1.5' }),
    row({ user_address: '0xC', market_id: '0xM2', block_number: '1', new_size: '7' }),
    row({ user_address: '0xD', market_id: '0xM1', block_number: '1', new_size: '2' }),
    row({ user_address: '0xD', market_id: '0xM1', block_number: '4', accounting_type: 'liquidation', new_size: '0' }),
    // Block numbers compare numerically, not lexically.
    row({ user_address: '0xE', market_id: '0xM1', block_number: '9', new_size: '1' }),
    row({ user_address: '0xE', market_id: '0xM1', block_number: '10', new_size: '6', accounting_type: 'increase' }),
  ];
  const all = openPositions(rows);
  const byKey = new Map(all.map((p) => [`${p.account}:${p.marketId}`, p.size]));
  assert.deepEqual(
    [...byKey.entries()].sort(),
    [
      ['0xb:0xm1', -15n * 10n ** 17n],
      ['0xc:0xm2', 7n * 10n ** 18n],
      ['0xe:0xm1', 6n * 10n ** 18n],
    ].sort()
  );

  const filtered = openPositions(rows, new Set(['0xm2']));
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].account, '0xc');
});

test('latestSizes keeps size-0 updates so an incremental apply can delete them', () => {
  const m = latestSizes([row({ accounting_type: 'close', new_size: null, block_number: '200' })]);
  assert.equal(m.get('0xaaa:0xm1')!.size, 0n);
});
