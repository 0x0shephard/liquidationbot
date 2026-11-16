import { createPublicClient, createWalletClient, http, type Log } from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from './config';
import { clearingHouseAbi, marketRegistryAbi, oracleAbi, vammAbi, tradeExecutedEvent, multicall3Abi } from './abis';
import { countingTransport } from './rpcStats';
import { Position, MarketInfo, MarketMeta, MarketSnapshot, TrackedPosition } from './types';

const WAD = 10n ** 18n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MULTICALL3 = sepolia.contracts.multicall3.address;

// Every request through either client is counted for RPC_STATS.
const transport = countingTransport(http(config.rpcUrl));

export const publicClient = createPublicClient({
  chain: sepolia,
  transport,
});

export const walletClient = config.privateKey
  ? createWalletClient({
      account: privateKeyToAccount(config.privateKey),
      chain: sepolia,
      transport,
    })
  : null;

export function getLiquidatorAddress(): `0x${string}` | null {
  return walletClient?.account?.address ?? null;
}

// ---------------------------------------------------------------------------
// RPC resilience
// ---------------------------------------------------------------------------

export function errorMessage(error: any): string {
  return (
    [error?.shortMessage, error?.details, error?.message, error?.cause?.message]
      .filter(Boolean)
      .join(' | ') || String(error)
  );
}

/** Custom error name from a viem ContractFunctionRevertedError, if decodable. */
export function revertErrorName(error: any): string | null {
  let e = error;
  for (let i = 0; e && i < 6; i++) {
    if (e?.data?.errorName) return e.data.errorName as string;
    e = e.cause;
  }
  return null;
}

function isRetryable(error: any): boolean {
  const message = errorMessage(error);

  // A contract revert is a deterministic answer, not a transport failure.
  if (/reverted|execution reverted|ContractFunctionRevertedError/i.test(message)) return false;

  // Auth and plan-tier rejections are permanent.
  if (/Must be authenticated|unauthorized|invalid api key|Archive requests require|Status: 40[13]/i.test(message)) {
    return false;
  }

  return /HTTP request failed|RPC Request failed|fetch failed|network|timeout|rate limit|429|50[0-4]|temporarily unavailable|connection/i.test(
    message
  );
}

/**
 * The CuOracle adapters revert with CuOracleAdapter_PriceStale() when their
 * price feed has not been refreshed inside the staleness window.
 */
export function isStaleOracleError(error: any): boolean {
  return (
    revertErrorName(error) === 'CuOracleAdapter_PriceStale' ||
    /CuOracleAdapter_PriceStale|0x4ffbfa58/i.test(errorMessage(error))
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withRpcRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let last: any;
  for (let attempt = 0; attempt <= config.rpcRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (!isRetryable(error) || attempt === config.rpcRetries) break;
      const delay = Math.min(config.rpcRetryDelayMs * 2 ** attempt, 30_000);
      console.warn(`${label} failed (${errorMessage(error)}). Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
  throw last;
}

// ---------------------------------------------------------------------------
// Market metadata: getMarket + marketRiskParams + liquidationPriceBandBps +
// vAMM.feeBps, refreshed every MARKET_CACHE_TTL_MS via two multicalls.
// ---------------------------------------------------------------------------

const metaCache = new Map<string, MarketMeta>();

/** Refresh metadata for any market that is missing or older than the TTL. */
export async function refreshMarketMeta(marketIds: Iterable<string>, force = false): Promise<void> {
  const now = Date.now();
  const due = [...new Set([...marketIds].map((m) => m.toLowerCase()))].filter((m) => {
    const hit = metaCache.get(m);
    return force || !hit || now - hit.fetchedAt > config.marketCacheTtlMs;
  }) as `0x${string}`[];
  if (due.length === 0) return;

  const stage1 = await publicClient.multicall({
    allowFailure: true,
    batchSize: config.multicallBatchBytes,
    contracts: due.flatMap((marketId) => [
      { address: config.marketRegistryAddress, abi: marketRegistryAbi, functionName: 'getMarket', args: [marketId] } as const,
      { address: config.clearingHouseAddress, abi: clearingHouseAbi, functionName: 'marketRiskParams', args: [marketId] } as const,
      { address: config.clearingHouseAddress, abi: clearingHouseAbi, functionName: 'liquidationPriceBandBps', args: [marketId] } as const,
    ]),
  });

  const partial: { marketId: `0x${string}`; meta: Omit<MarketMeta, 'vammFeeBps'> }[] = [];
  due.forEach((marketId, i) => {
    const [mRes, rRes, bRes] = [stage1[i * 3], stage1[i * 3 + 1], stage1[i * 3 + 2]];
    if (mRes.status !== 'success' || rRes.status !== 'success') {
      console.warn(
        `Market metadata read failed for ${marketId.slice(0, 10)}...: ${errorMessage(mRes.error ?? rRes.error)}`
      );
      return;
    }
    const m = mRes.result as any;
    const r = rRes.result as readonly bigint[];
    const info: MarketInfo = {
      vamm: m.vamm,
      feeBps: m.feeBps,
      paused: m.paused,
      oracle: m.oracle,
      feeRouter: m.feeRouter,
      insuranceFund: m.insuranceFund,
      baseAsset: m.baseAsset,
      quoteToken: m.quoteToken,
      baseUnit: m.baseUnit,
    };
    partial.push({
      marketId,
      meta: {
        info,
        risk: {
          imrBps: r[0],
          mmrBps: r[1],
          liquidationPenaltyBps: r[2],
          penaltyCap: r[3],
          maxPositionSize: r[4],
          minPositionSize: r[5],
        },
        // A revert here means the ClearingHouse predates the price band: no band.
        bandBps: bRes.status === 'success' ? (bRes.result as bigint) : null,
        fetchedAt: now,
      },
    });
  });

  if (partial.length === 0) return;

  const stage2 = await publicClient.multicall({
    allowFailure: true,
    batchSize: config.multicallBatchBytes,
    contracts: partial.map((p) => ({ address: p.meta.info.vamm, abi: vammAbi, functionName: 'feeBps' }) as const),
  });

  partial.forEach((p, i) => {
    const fee = stage2[i];
    metaCache.set(p.marketId, {
      ...p.meta,
      vammFeeBps: fee.status === 'success' ? BigInt(fee.result as number) : null,
    });
  });
}

export async function getMarketMeta(marketId: `0x${string}`): Promise<MarketMeta> {
  await refreshMarketMeta([marketId]);
  const meta = metaCache.get(marketId.toLowerCase());
  if (!meta) throw new Error(`Market metadata unavailable for ${marketId}`);
  return meta;
}

export function getCachedMarketMeta(marketId: string): MarketMeta | undefined {
  return metaCache.get(marketId.toLowerCase());
}

// ---------------------------------------------------------------------------
// Per-cycle snapshot: one multicall (Multicall3.aggregate3) with
//   Multicall3.getBlockNumber                           (chain head, no extra call)
//   per market:   oracle.getPrice, vamm.getReserves      (mark = Y*1e18/X)
//   per position: isLiquidatable, getMarginRatio
// viem splits it into several aggregate3 calls only past MULTICALL_BATCH_BYTES.
// ---------------------------------------------------------------------------

export interface PositionRead {
  liquidatable: boolean | null; // null = read failed
  marginRatioX18: bigint | null;
  error?: unknown;
}

export interface CycleSnapshot {
  blockNumber: bigint;
  markets: Map<string, MarketSnapshot>;
  positions: Map<string, PositionRead>;
  marketErrors: Map<string, unknown>;
}

export async function readCycleSnapshot(
  positions: TrackedPosition[],
  marketIds: string[]
): Promise<CycleSnapshot> {
  const contracts: any[] = [{ address: MULTICALL3, abi: multicall3Abi, functionName: 'getBlockNumber' }];
  const marketIdx: { marketId: string; at: number }[] = [];
  for (const raw of marketIds) {
    const marketId = raw.toLowerCase();
    const meta = getCachedMarketMeta(marketId);
    if (!meta) continue;
    marketIdx.push({ marketId, at: contracts.length });
    contracts.push({ address: meta.info.oracle, abi: oracleAbi, functionName: 'getPrice' });
    contracts.push({ address: meta.info.vamm, abi: vammAbi, functionName: 'getReserves' });
  }
  const posStart = contracts.length;
  for (const p of positions) {
    contracts.push({ address: config.clearingHouseAddress, abi: clearingHouseAbi, functionName: 'isLiquidatable', args: [p.account, p.marketId] });
    contracts.push({ address: config.clearingHouseAddress, abi: clearingHouseAbi, functionName: 'getMarginRatio', args: [p.account, p.marketId] });
  }

  const results = await publicClient.multicall({
    allowFailure: true,
    batchSize: config.multicallBatchBytes,
    contracts,
  });

  // viem folds a transport failure into per-call failures; the sentinel tells
  // "RPC down" apart from "a contract reverted".
  if (results[0].status !== 'success') {
    throw new Error(`Cycle multicall failed: ${errorMessage(results[0].error)}`);
  }

  const markets = new Map<string, MarketSnapshot>();
  const marketErrors = new Map<string, unknown>();
  for (const { marketId, at } of marketIdx) {
    const price = results[at];
    const reserves = results[at + 1];
    let base: bigint | null = null;
    let quote: bigint | null = null;
    if (reserves.status === 'success') {
      [base, quote] = reserves.result as readonly [bigint, bigint];
    }
    if (price.status !== 'success') marketErrors.set(marketId, price.error);
    markets.set(marketId, {
      indexPriceX18: price.status === 'success' ? (price.result as bigint) : null,
      markPriceX18: base !== null && quote !== null && base > 0n ? (quote * WAD) / base : null,
      baseReserve: base,
      quoteReserve: quote,
    });
  }

  const positionsOut = new Map<string, PositionRead>();
  positions.forEach((p, i) => {
    const liq = results[posStart + i * 2];
    const ratio = results[posStart + i * 2 + 1];
    positionsOut.set(`${p.account.toLowerCase()}:${p.marketId.toLowerCase()}`, {
      liquidatable: liq.status === 'success' ? (liq.result as boolean) : null,
      marginRatioX18: ratio.status === 'success' ? (ratio.result as bigint) : null,
      error: liq.status === 'success' ? undefined : liq.error,
    });
  });

  return { blockNumber: results[0].result as bigint, markets, positions: positionsOut, marketErrors };
}

// ---------------------------------------------------------------------------
// Single reads (startup / CLI / rare paths only)
// ---------------------------------------------------------------------------

export async function getPosition(account: `0x${string}`, marketId: `0x${string}`): Promise<Position> {
  const p = await withRpcRetry(`getPosition ${account}`, () =>
    publicClient.readContract({
      address: config.clearingHouseAddress,
      abi: clearingHouseAbi,
      functionName: 'getPosition',
      args: [account, marketId],
    })
  );

  return {
    size: p.size,
    margin: p.margin,
    entryPriceX18: p.entryPriceX18,
    lastFundingPayIndex: p.lastFundingPayIndex,
    lastFundingReceiveIndex: p.lastFundingReceiveIndex,
    realizedPnL: p.realizedPnL,
  };
}

export async function isWhitelistedLiquidator(address: `0x${string}`): Promise<boolean> {
  return await withRpcRetry('whitelistedLiquidators', () =>
    publicClient.readContract({
      address: config.clearingHouseAddress,
      abi: clearingHouseAbi,
      functionName: 'whitelistedLiquidators',
      args: [address],
    })
  );
}

export async function getCurrentBlockNumber(): Promise<bigint> {
  return await withRpcRetry('getBlockNumber', () => publicClient.getBlockNumber());
}

/** EIP-1559 fee estimate (wei). */
export async function estimateFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const fees = await withRpcRetry('estimateFeesPerGas', () => publicClient.estimateFeesPerGas());
  return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
}

// ---------------------------------------------------------------------------
// Event indexing (fallback position source)
// ---------------------------------------------------------------------------

export type TradeExecutedLog = Log<bigint, number, false, typeof tradeExecutedEvent>;

// Public RPCs cap block range and response size, and the cap is not discoverable
// up front. Bisect on rejection rather than guessing a safe chunk size.
export async function getTradeLogs(fromBlock: bigint, toBlock: bigint): Promise<TradeExecutedLog[]> {
  try {
    return (await withRpcRetry(`getLogs ${fromBlock}-${toBlock}`, () =>
      publicClient.getLogs({
        address: config.clearingHouseAddress,
        event: tradeExecutedEvent,
        fromBlock,
        toBlock,
      })
    )) as TradeExecutedLog[];
  } catch (error: any) {
    if (fromBlock >= toBlock) throw error;
    if (!/block range|too many|response size|limit|range/i.test(errorMessage(error))) throw error;

    const mid = fromBlock + (toBlock - fromBlock) / 2n;
    const [left, right] = [await getTradeLogs(fromBlock, mid), await getTradeLogs(mid + 1n, toBlock)];
    return [...left, ...right];
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * The single execution of liquidate() before sending: eth_estimateGas both
 * simulates (a revert is decoded against clearingHouseAbi) and yields the gas
 * that is then passed to writeContract, so viem does not simulate or estimate
 * again.
 *
 * Gas is not pinned here: liquidate() settles funding across every market the
 * account is active in, so cost scales with their portfolio.
 */
export async function estimateLiquidationGas(
  account: `0x${string}`,
  marketId: `0x${string}`,
  size: bigint,
  amountLimit: bigint
): Promise<bigint> {
  if (!walletClient) throw new Error('Wallet client not initialized - PRIVATE_KEY required');

  const gas = await publicClient.estimateContractGas({
    address: config.clearingHouseAddress,
    abi: clearingHouseAbi,
    functionName: 'liquidate',
    args: [account, marketId, size, amountLimit],
    account: walletClient.account,
  });

  if (gas > config.gasLimit) {
    throw new Error(`Liquidation needs ${gas} gas, above GAS_LIMIT ${config.gasLimit}. Raise GAS_LIMIT.`);
  }
  return gas;
}

export async function sendLiquidation(params: {
  account: `0x${string}`;
  marketId: `0x${string}`;
  size: bigint;
  amountLimit: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}): Promise<`0x${string}`> {
  if (!walletClient) throw new Error('Wallet client not initialized - PRIVATE_KEY required');
  return await walletClient.writeContract({
    address: config.clearingHouseAddress,
    abi: clearingHouseAbi,
    functionName: 'liquidate',
    args: [params.account, params.marketId, params.size, params.amountLimit],
    account: walletClient.account,
    chain: sepolia,
    gas: params.gas,
    maxFeePerGas: params.maxFeePerGas,
    maxPriorityFeePerGas: params.maxPriorityFeePerGas,
  });
}

export async function executePokeFunding(
  vamm: `0x${string}`,
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
): Promise<`0x${string}`> {
  if (!walletClient) throw new Error('Wallet client not initialized - PRIVATE_KEY required');

  const gas = await publicClient.estimateContractGas({
    address: vamm,
    abi: vammAbi,
    functionName: 'pokeFunding',
    account: walletClient.account,
  });

  return await walletClient.writeContract({
    address: vamm,
    abi: vammAbi,
    functionName: 'pokeFunding',
    account: walletClient.account,
    chain: sepolia,
    gas: (gas * 12n) / 10n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
}

export async function waitForTransaction(hash: `0x${string}`) {
  // 6s poll suits Sepolia's 12s blocks (default is 4s); the timeout stops a
  // fee-capped tx from hanging the loop forever.
  return await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 6_000, timeout: 180_000 });
}

export function hasFeeRouter(market: MarketInfo): boolean {
  return market.feeRouter !== ZERO_ADDRESS;
}
