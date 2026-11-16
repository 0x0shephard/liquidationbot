/**
 * Open-position index.
 *
 * Two interchangeable sources feed the same in-memory map, and both carry the
 * post-trade size so opens/resizes/closes/liquidations collapse to one signal:
 *
 *  - supabase: canonical_pnl_events (written by canonical-indexer), read-only.
 *    Startup loads the latest size-bearing row per (user, market); each cycle
 *    then reads rows with cursor < block_number <= indexer checkpoint.
 *  - logs: the bot's own incremental eth_getLogs over TradeExecuted.
 *
 * The logs source is used when Supabase is not configured, errors, or the
 * indexer checkpoint is more than INDEXER_MAX_LAG_BLOCKS behind the chain head,
 * so liquidations never depend on the indexer being up. Applying the same
 * event from both sources is idempotent (the latest size wins), and the shared
 * cursor means each block range is read from only one of them.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { TrackedPosition, HealthStatus } from './types';
import { getTradeLogs, getPosition, type TradeExecutedLog } from './blockchain';
import { config } from './config';
import { latestSizes, positionKey, type PnlEventRow, type PositionUpdate } from './supabaseRows';

type SourceMode = 'supabase' | 'logs';

const trackedPositions = new Map<string, TrackedPosition>();
const lastTradeBlockByMarket = new Map<string, bigint>();
let lastSyncedBlock: bigint = config.startBlock - 1n;
let mode: SourceMode = 'logs';
let lastIndexerBlock: bigint | null = null;

let supabase: SupabaseClient | null = null;
function supabaseClient(): SupabaseClient | null {
  if (!config.supabaseUrl || !config.supabaseKey) return null;
  if (!supabase) {
    supabase = createClient(config.supabaseUrl, config.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return supabase;
}

function noteTrade(marketId: string, block: bigint): void {
  const prev = lastTradeBlockByMarket.get(marketId);
  if (prev === undefined || block > prev) lastTradeBlockByMarket.set(marketId, block);
}

function applyUpdate(u: PositionUpdate): void {
  const key = positionKey(u.account, u.marketId);
  noteTrade(u.marketId, u.blockNumber);

  if (u.size === 0n) {
    trackedPositions.delete(key);
    return;
  }
  const existing = trackedPositions.get(key);
  trackedPositions.set(key, {
    account: u.account,
    marketId: u.marketId,
    size: u.size,
    updatedBlock: u.blockNumber,
    lastChecked: existing?.lastChecked ?? 0,
    healthStatus: existing?.healthStatus ?? HealthStatus.SAFE,
  });
}

// ---------------------------------------------------------------------------
// Supabase source (read-only)
// ---------------------------------------------------------------------------

// numeric columns are cast to text so PostgREST does not round them through a
// JS float (new_size has 18 decimals).
const ROW_COLUMNS =
  'user_address,market_id,accounting_type,block_number::text,transaction_index,primary_log_index,new_size::text';

async function getIndexerCheckpoint(client: SupabaseClient): Promise<bigint> {
  const { data, error } = await client
    .from('canonical_indexer_checkpoints')
    .select('last_block_number::text')
    .eq('indexer_name', config.indexerName)
    .eq('chain_id', config.chainId)
    .maybeSingle();
  if (error) throw new Error(`checkpoint read failed: ${error.message}`);
  if (!data) throw new Error(`no checkpoint for indexer '${config.indexerName}' chain ${config.chainId}`);
  return BigInt((data as any).last_block_number);
}

/** Size-bearing rows with fromExclusive < block_number <= toInclusive, paged. */
async function fetchRows(client: SupabaseClient, fromExclusive: bigint, toInclusive: bigint): Promise<PnlEventRow[]> {
  const rows: PnlEventRow[] = [];
  const pageSize = config.supabasePageSize;

  for (let offset = 0; ; offset += pageSize) {
    let q = client
      .from('canonical_pnl_events')
      .select(ROW_COLUMNS)
      .eq('chain_id', config.chainId)
      .eq('clearing_house', config.clearingHouseAddress.toLowerCase())
      .gt('block_number', fromExclusive.toString())
      .lte('block_number', toInclusive.toString())
      .or('new_size.not.is.null,accounting_type.eq.close');

    if (config.marketIds.size > 0) q = q.in('market_id', [...config.marketIds]);

    const { data, error } = await q
      .order('block_number', { ascending: true })
      .order('transaction_index', { ascending: true })
      .order('primary_log_index', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error) throw new Error(`canonical_pnl_events read failed: ${error.message}`);
    const page = (data ?? []) as unknown as PnlEventRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function syncFromSupabase(client: SupabaseClient, toBlock: bigint): Promise<number> {
  if (toBlock <= lastSyncedBlock) return 0;
  const rows = await fetchRows(client, lastSyncedBlock, toBlock);
  for (const u of latestSizes(rows, config.marketIds).values()) applyUpdate(u);
  lastSyncedBlock = toBlock;
  return rows.length;
}

// ---------------------------------------------------------------------------
// On-chain getLogs source (fallback)
// ---------------------------------------------------------------------------

function applyTradeLog(log: TradeExecutedLog): void {
  const marketId = log.args.marketId!.toLowerCase() as `0x${string}`;
  if (config.marketIds.size > 0 && !config.marketIds.has(marketId)) return;

  applyUpdate({
    account: log.args.user!.toLowerCase() as `0x${string}`,
    marketId,
    size: log.args.newSize!,
    blockNumber: log.blockNumber!,
    timestampMs: null,
  });
}

async function syncFromLogs(fromBlock: bigint, toBlock: bigint): Promise<number> {
  if (toBlock < fromBlock) return 0;

  let total = 0;
  for (let start = fromBlock; start <= toBlock; start += config.logChunkSize) {
    const end = start + config.logChunkSize - 1n > toBlock ? toBlock : start + config.logChunkSize - 1n;
    const logs = await getTradeLogs(start, end);
    for (const log of logs) applyTradeLog(log);
    total += logs.length;
    if (logs.length > 0) console.log(`Indexed TradeExecuted ${start}-${end}: ${logs.length} log(s)`);
  }

  lastSyncedBlock = toBlock;
  return total;
}

function setMode(next: SourceMode, reason: string): void {
  if (next !== mode) console.log(`Position source -> ${next} (${reason})`);
  mode = next;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function initializeTracker(head: bigint): Promise<void> {
  const client = supabaseClient();

  if (client) {
    try {
      const checkpoint = await getIndexerCheckpoint(client);
      lastIndexerBlock = checkpoint;
      console.log(`Loading positions from canonical_pnl_events up to indexer checkpoint ${checkpoint}...`);
      lastSyncedBlock = -1n;
      const rows = await syncFromSupabase(client, checkpoint);
      console.log(`Loaded ${rows} size-bearing row(s): ${trackedPositions.size} open position(s)`);
      setMode('supabase', 'startup');

      if (head - checkpoint > config.indexerMaxLagBlocks) {
        console.warn(
          `Indexer checkpoint ${checkpoint} lags head ${head} by ${head - checkpoint} blocks - catching up via getLogs`
        );
        setMode('logs', 'indexer lagging');
        await syncFromLogs(lastSyncedBlock + 1n, head);
      }
      return;
    } catch (error: any) {
      console.warn(`Supabase position load failed (${error.message}) - falling back to getLogs replay from START_BLOCK`);
      trackedPositions.clear();
      lastTradeBlockByMarket.clear();
      lastSyncedBlock = config.startBlock - 1n;
    }
  }

  setMode('logs', client ? 'supabase unavailable' : 'supabase not configured');
  console.log(`Backfilling TradeExecuted from block ${config.startBlock} to ${head}...`);
  const count = await syncFromLogs(config.startBlock, head);
  console.log(`Backfill complete: ${count} log(s), ${trackedPositions.size} open position(s)`);
}

/**
 * Incremental sync, once per cycle. `head` is the chain head from the previous
 * cycle's multicall (no extra eth_blockNumber).
 */
export async function syncPositions(head: bigint): Promise<bigint> {
  const client = supabaseClient();

  if (client) {
    try {
      const checkpoint = await getIndexerCheckpoint(client);
      lastIndexerBlock = checkpoint;
      const lag = head > checkpoint ? head - checkpoint : 0n;

      if (lag <= config.indexerMaxLagBlocks) {
        setMode('supabase', `indexer lag ${lag} blocks`);
        await syncFromSupabase(client, checkpoint);
        return lastSyncedBlock;
      }
      setMode('logs', `indexer lag ${lag} blocks > ${config.indexerMaxLagBlocks}`);
    } catch (error: any) {
      setMode('logs', `supabase error: ${error.message}`);
    }
  }

  if (head > lastSyncedBlock) await syncFromLogs(lastSyncedBlock + 1n, head);
  return lastSyncedBlock;
}

export function getAllTrackedPositions(): TrackedPosition[] {
  return Array.from(trackedPositions.values());
}

export function getLastTradeBlock(marketId: string): bigint | undefined {
  return lastTradeBlockByMarket.get(marketId.toLowerCase());
}

export function updateTrackedPosition(
  account: `0x${string}`,
  marketId: `0x${string}`,
  updates: Partial<TrackedPosition>
): void {
  const key = positionKey(account, marketId);
  const existing = trackedPositions.get(key);
  if (existing) trackedPositions.set(key, { ...existing, ...updates });
}

export function removePosition(account: `0x${string}`, marketId: `0x${string}`): void {
  trackedPositions.delete(positionKey(account, marketId));
}

/** Track an account explicitly, bypassing event discovery (--track). */
export async function trackSpecificAccount(account: `0x${string}`, marketId: `0x${string}`): Promise<void> {
  const position = await getPosition(account, marketId);
  if (position.size === 0n) {
    console.log(`${account} has no open position in ${marketId}`);
    return;
  }

  trackedPositions.set(positionKey(account, marketId), {
    account: account.toLowerCase() as `0x${string}`,
    marketId: marketId.toLowerCase() as `0x${string}`,
    size: position.size,
    updatedBlock: 0n,
    lastChecked: 0,
    healthStatus: HealthStatus.SAFE,
  });

  console.log(`Tracking ${account} in ${marketId} (size ${position.size})`);
}

export function getTrackerStats() {
  const positions = getAllTrackedPositions();
  return {
    source: mode,
    lastSyncedBlock: lastSyncedBlock.toString(),
    indexerCheckpoint: lastIndexerBlock?.toString() ?? null,
    total: positions.length,
    safe: positions.filter((p) => p.healthStatus === HealthStatus.SAFE).length,
    warning: positions.filter((p) => p.healthStatus === HealthStatus.WARNING).length,
    liquidatable: positions.filter((p) => p.healthStatus === HealthStatus.LIQUIDATABLE).length,
  };
}
