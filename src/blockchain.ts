import { createPublicClient, createWalletClient, http, type Log } from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from './config';
import { clearingHouseAbi, marketRegistryAbi, oracleAbi, vammAbi, tradeExecutedEvent } from './abis';
import { Position, MarketInfo, MarketRiskParams, MarginHealth, HealthStatus } from './types';

const WAD = 10n ** 18n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(config.rpcUrl),
});

export const walletClient = config.privateKey
  ? createWalletClient({
      account: privateKeyToAccount(config.privateKey),
      chain: sepolia,
      transport: http(config.rpcUrl),
    })
  : null;

export function getLiquidatorAddress(): `0x${string}` | null {
  return walletClient?.account?.address ?? null;
}

// ---------------------------------------------------------------------------
// RPC resilience
// ---------------------------------------------------------------------------

function errorMessage(error: any): string {
  return (
    [error?.shortMessage, error?.details, error?.message, error?.cause?.message]
      .filter(Boolean)
      .join(' | ') || String(error)
  );
}

function isRetryable(error: any): boolean {
  const message = errorMessage(error);

  // A contract revert is a deterministic answer, not a transport failure.
  // Retrying it just burns the backoff budget (and a stale oracle reverts on
  // every market, every cycle).
  if (/reverted|execution reverted|ContractFunctionRevertedError/i.test(message)) return false;

  // Auth and plan-tier rejections are permanent: a bad API key or a
  // non-archive endpoint will fail identically on every retry.
  if (/Must be authenticated|unauthorized|invalid api key|Archive requests require|Status: 40[13]/i.test(message)) {
    return false;
  }

  return /HTTP request failed|RPC Request failed|fetch failed|network|timeout|rate limit|429|50[0-4]|temporarily unavailable|connection/i.test(
    message
  );
}

/**
 * The CuOracle adapters revert with CuOracleAdapter_PriceStale() when their
 * price feed has not been refreshed inside the staleness window. On testnet this
 * is common and affects every read that prices a market, so it is detected
 * explicitly and handled as "skip this market" rather than a hard failure.
 */
export function isStaleOracleError(error: any): boolean {
  return /CuOracleAdapter_PriceStale|0x4ffbfa58/i.test(errorMessage(error));
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
// Market metadata (cached - these are effectively immutable per market)
// ---------------------------------------------------------------------------

const marketCache = new Map<string, MarketInfo>();

export async function getMarket(marketId: `0x${string}`): Promise<MarketInfo> {
  const cached = marketCache.get(marketId.toLowerCase());
  if (cached) return cached;

  const m = await withRpcRetry(`getMarket ${marketId}`, () =>
    publicClient.readContract({
      address: config.marketRegistryAddress,
      abi: marketRegistryAbi,
      functionName: 'getMarket',
      args: [marketId],
    })
  );

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

  marketCache.set(marketId.toLowerCase(), info);
  return info;
}

export async function isMarketActive(marketId: `0x${string}`): Promise<boolean> {
  return await withRpcRetry(`isActive ${marketId}`, () =>
    publicClient.readContract({
      address: config.marketRegistryAddress,
      abi: marketRegistryAbi,
      functionName: 'isActive',
      args: [marketId],
    })
  );
}

// Risk params are admin-settable, so re-read them each cycle rather than caching
// for the process lifetime.
export async function getRiskParams(marketId: `0x${string}`): Promise<MarketRiskParams> {
  const [imrBps, mmrBps, liquidationPenaltyBps, penaltyCap, maxPositionSize, minPositionSize] =
    await withRpcRetry(`marketRiskParams ${marketId}`, () =>
      publicClient.readContract({
        address: config.clearingHouseAddress,
        abi: clearingHouseAbi,
        functionName: 'marketRiskParams',
        args: [marketId],
      })
    );

  return { imrBps, mmrBps, liquidationPenaltyBps, penaltyCap, maxPositionSize, minPositionSize };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getPosition(
  account: `0x${string}`,
  marketId: `0x${string}`
): Promise<Position> {
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

export async function isLiquidatable(
  account: `0x${string}`,
  marketId: `0x${string}`
): Promise<boolean> {
  return await withRpcRetry(`isLiquidatable ${account}`, () =>
    publicClient.readContract({
      address: config.clearingHouseAddress,
      abi: clearingHouseAbi,
      functionName: 'isLiquidatable',
      args: [account, marketId],
    })
  );
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

export async function getOraclePrice(oracle: `0x${string}`): Promise<bigint> {
  return await withRpcRetry(`oracle.getPrice ${oracle}`, () =>
    publicClient.readContract({ address: oracle, abi: oracleAbi, functionName: 'getPrice' })
  );
}

export async function getMarkPrice(vamm: `0x${string}`): Promise<bigint> {
  return await withRpcRetry(`vamm.getMarkPrice ${vamm}`, () =>
    publicClient.readContract({ address: vamm, abi: vammAbi, functionName: 'getMarkPrice' })
  );
}

export async function getCurrentBlockNumber(): Promise<bigint> {
  return await withRpcRetry('getBlockNumber', () => publicClient.getBlockNumber());
}

export async function getGasPriceGwei(): Promise<number> {
  const gasPrice = await withRpcRetry('getGasPrice', () => publicClient.getGasPrice());
  return Number(gasPrice) / 1e9;
}

// ---------------------------------------------------------------------------
// Event indexing
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
// Margin health
//
// On-chain isLiquidatable() folds in pending funding and real-time collateral
// valuation (quote depeg), which cannot be faithfully reproduced off-chain. It
// is therefore the sole authority for LIQUIDATABLE. The IMR comparison below is
// only used to raise an early WARNING and is deliberately approximate.
// ---------------------------------------------------------------------------

export async function calculateMarginHealth(
  account: `0x${string}`,
  marketId: `0x${string}`,
  position?: Position
): Promise<MarginHealth> {
  const market = await getMarket(marketId);
  const [pos, params, oraclePriceX18, liquidatable] = await Promise.all([
    position ? Promise.resolve(position) : getPosition(account, marketId),
    getRiskParams(marketId),
    getOraclePrice(market.oracle),
    isLiquidatable(account, marketId),
  ]);

  if (pos.size === 0n) {
    return {
      effectiveMargin: 0n,
      maintenanceMargin: 0n,
      initialMargin: 0n,
      marginRatio: 0,
      status: HealthStatus.SAFE,
      unrealizedPnL: 0n,
      notionalValue: 0n,
      oraclePriceX18,
    };
  }

  const absSize = pos.size < 0n ? -pos.size : pos.size;

  // Signed size makes this one expression for both directions.
  const unrealizedPnL = ((oraclePriceX18 - pos.entryPriceX18) * pos.size) / WAD;
  const effectiveMargin = pos.margin + unrealizedPnL;
  const notionalValue = (absSize * oraclePriceX18) / WAD;

  const initialMargin = (notionalValue * params.imrBps) / 10_000n;
  const maintenanceMargin = (notionalValue * params.mmrBps) / 10_000n;

  let status: HealthStatus;
  if (liquidatable) {
    status = HealthStatus.LIQUIDATABLE;
  } else if (effectiveMargin < initialMargin) {
    status = HealthStatus.WARNING;
  } else {
    status = HealthStatus.SAFE;
  }

  const marginRatio =
    notionalValue > 0n ? Number((effectiveMargin * 10_000n) / notionalValue) / 100 : 0;

  return {
    effectiveMargin,
    maintenanceMargin,
    initialMargin,
    marginRatio,
    status,
    unrealizedPnL,
    notionalValue,
    oraclePriceX18,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * amountLimit is the slippage guard on the vAMM leg of the liquidation: a
 * minimum quote-out when closing a long, a maximum quote-in when closing a
 * short. 0 disables the guard.
 */
export async function computeAmountLimit(
  marketId: `0x${string}`,
  positionSize: bigint,
  liquidationSize: bigint
): Promise<bigint> {
  if (config.amountLimitMode !== 'mark') return 0n;

  const market = await getMarket(marketId);
  const markPrice = await getMarkPrice(market.vamm);
  const notional = (liquidationSize * markPrice) / WAD;

  return positionSize > 0n
    ? (notional * (10_000n - config.slippageBps)) / 10_000n
    : (notional * (10_000n + config.slippageBps)) / 10_000n;
}

/** Simulate a liquidation. Returns the request to send, or null if it would revert. */
export async function simulateLiquidation(
  account: `0x${string}`,
  marketId: `0x${string}`,
  size: bigint,
  amountLimit: bigint
) {
  if (!walletClient) throw new Error('Wallet client not initialized - PRIVATE_KEY required');

  const { request } = await publicClient.simulateContract({
    address: config.clearingHouseAddress,
    abi: clearingHouseAbi,
    functionName: 'liquidate',
    args: [account, marketId, size, amountLimit],
    account: walletClient.account,
    gas: config.gasLimit,
  });

  return request;
}

export async function sendLiquidation(request: any): Promise<`0x${string}`> {
  if (!walletClient) throw new Error('Wallet client not initialized - PRIVATE_KEY required');
  return await walletClient.writeContract(request);
}

export async function executePokeFunding(marketId: `0x${string}`): Promise<`0x${string}`> {
  if (!walletClient) throw new Error('Wallet client not initialized - PRIVATE_KEY required');

  const market = await getMarket(marketId);
  const { request } = await publicClient.simulateContract({
    address: market.vamm,
    abi: vammAbi,
    functionName: 'pokeFunding',
    account: walletClient.account,
  });

  return await walletClient.writeContract(request);
}

export async function waitForTransaction(hash: `0x${string}`) {
  return await publicClient.waitForTransactionReceipt({ hash });
}

export function hasFeeRouter(market: MarketInfo): boolean {
  return market.feeRouter !== ZERO_ADDRESS;
}
