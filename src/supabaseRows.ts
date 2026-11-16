/**
 * Pure helpers for rebuilding open positions from canonical_pnl_events rows.
 * No I/O here so they can be unit-tested.
 */
import { parseUnits } from 'viem';

export interface PnlEventRow {
  user_address: string;
  market_id: string;
  accounting_type: string;
  block_number: string | number;
  transaction_index: number | null;
  primary_log_index: number | null;
  new_size: string | number | null;
  block_timestamp?: string | null;
}

export interface PositionUpdate {
  account: `0x${string}`;
  marketId: `0x${string}`;
  size: bigint;
  blockNumber: bigint;
  timestampMs: number | null;
}

/** Expand a JS number / exponent string to a plain decimal string. */
function toPlainDecimal(value: string | number): string {
  let s = typeof value === 'number' ? value.toString() : value.trim();
  const m = /^([+-]?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(s);
  if (!m) return s;
  const [, sign, intPart, fracPart = '', expStr] = m;
  const exp = Number(expStr);
  let digits = intPart + fracPart;
  let point = intPart.length + exp;
  if (point <= 0) {
    digits = '0'.repeat(-point + 1) + digits;
    point = 1;
  } else if (point > digits.length) {
    digits = digits + '0'.repeat(point - digits.length);
  }
  const out = `${digits.slice(0, point)}.${digits.slice(point)}`.replace(/\.$/, '');
  return `${sign === '-' ? '-' : ''}${out}`;
}

/**
 * new_size is written by the indexer as formatUnits(newSize, 18): a signed
 * decimal string in 18-decimal units. Parse it back to the on-chain int256.
 * Postgres may pad trailing zeros ("1.500000000000000000") - harmless.
 * More than 18 fractional digits cannot come from formatUnits(…,18); extra
 * zeros are stripped, anything else throws rather than silently rounding.
 */
export function parseNewSize(value: string | number): bigint {
  let s = toPlainDecimal(value);
  if (!/^[+-]?\d*(\.\d*)?$/.test(s) || s === '' || s === '.' || /^[+-]$/.test(s)) {
    throw new Error(`Invalid new_size: ${String(value)}`);
  }
  if (s.startsWith('+')) s = s.slice(1);
  const dot = s.indexOf('.');
  if (dot >= 0) {
    let frac = s.slice(dot + 1);
    if (frac.length > 18) {
      const extra = frac.slice(18);
      if (!/^0*$/.test(extra)) throw new Error(`new_size has more than 18 decimals: ${String(value)}`);
      frac = frac.slice(0, 18);
    }
    s = `${s.slice(0, dot) || '0'}${frac ? `.${frac}` : ''}`;
  }
  return parseUnits(s, 18);
}

/**
 * Size implied by a row, or undefined when the row carries no size information
 * (margin/funding rows). A 'close' row without new_size (PositionClosed with no
 * TradeExecuted in the same group) means flat.
 */
export function rowSize(row: PnlEventRow): bigint | undefined {
  if (row.new_size !== null && row.new_size !== undefined && row.new_size !== '') {
    return parseNewSize(row.new_size);
  }
  if (row.accounting_type === 'close') return 0n;
  return undefined;
}

export function compareRows(a: PnlEventRow, b: PnlEventRow): number {
  const ab = BigInt(a.block_number);
  const bb = BigInt(b.block_number);
  if (ab !== bb) return ab < bb ? -1 : 1;
  const at = a.transaction_index ?? 0;
  const bt = b.transaction_index ?? 0;
  if (at !== bt) return at - bt;
  return (a.primary_log_index ?? 0) - (b.primary_log_index ?? 0);
}

export function positionKey(account: string, marketId: string): string {
  return `${account.toLowerCase()}:${marketId.toLowerCase()}`;
}

/**
 * Latest size-bearing row per (user_address, market_id), ordered by
 * (block_number, transaction_index, primary_log_index). Returns every key that
 * was touched, including size 0 (so an incremental apply can delete it).
 */
export function latestSizes(
  rows: PnlEventRow[],
  marketFilter?: Set<string>
): Map<string, PositionUpdate> {
  const out = new Map<string, PositionUpdate>();
  const sorted = [...rows].sort(compareRows);

  for (const row of sorted) {
    const marketId = row.market_id.toLowerCase();
    if (marketFilter && marketFilter.size > 0 && !marketFilter.has(marketId)) continue;
    const size = rowSize(row);
    if (size === undefined) continue;

    const ts = row.block_timestamp ? Date.parse(row.block_timestamp) : NaN;
    out.set(positionKey(row.user_address, marketId), {
      account: row.user_address.toLowerCase() as `0x${string}`,
      marketId: marketId as `0x${string}`,
      size,
      blockNumber: BigInt(row.block_number),
      timestampMs: Number.isFinite(ts) ? ts : null,
    });
  }
  return out;
}

/** Open positions only (new_size != 0). */
export function openPositions(rows: PnlEventRow[], marketFilter?: Set<string>): PositionUpdate[] {
  return [...latestSizes(rows, marketFilter).values()].filter((p) => p.size !== 0n);
}
