import dotenv from 'dotenv';

dotenv.config();

function int(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  return raw ? Number.parseInt(raw, 10) : fallback;
}

function float(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  return raw ? Number.parseFloat(raw) : fallback;
}

function big(name: string, fallback: bigint): bigint {
  const raw = process.env[name]?.trim();
  return raw ? BigInt(raw) : fallback;
}

// Optional allowlist of markets. Empty set = watch every market the
// ClearingHouse emits trades for.
function parseMarketIds(): Set<string> {
  const raw = process.env.MARKET_IDS?.trim();
  if (!raw) return new Set();
  return new Set(
    raw.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean)
  );
}

export const config = {
  rpcUrl: process.env.RPC_URL || process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',

  // Sepolia deployment (deployments/sepolia-addresses.md, 2026-05-08).
  // The ClearingHouse address is the proxy - never the implementation.
  clearingHouseAddress: (process.env.CLEARING_HOUSE_ADDRESS as `0x${string}`) || '0xDf4DDD4019097B335dD507f916984A1A53E40a0d',
  marketRegistryAddress: (process.env.MARKET_REGISTRY_ADDRESS as `0x${string}`) || '0x236b75D39203506ee3180Ef2E1c7460a188C43c6',

  // Per-market vAMM/oracle/feeRouter are resolved from the MarketRegistry at
  // runtime, so they are deliberately not configured here.
  marketIds: parseMarketIds(),

  // Earliest Sepolia deployment receipt. Only used for a getLogs replay (no
  // Supabase, or Supabase unreachable at startup). Raise it to speed that up.
  startBlock: big('START_BLOCK', 10_797_215n),
  logChunkSize: big('LOG_CHUNK_SIZE', 10_000n),

  // Execution
  privateKey: (process.env.PRIVATE_KEY as `0x${string}`) || '',
  executeMode: process.env.EXECUTE_MODE === 'true',
  dryRun: process.env.DRY_RUN === 'true',
  // Upper sanity bound, not the gas actually sent - that comes from estimation.
  // liquidate() settles funding across every market the account is active in, so
  // a multi-market account really does cost >1.1M gas. 900k was too low and made
  // simulations run out of gas.
  gasLimit: big('GAS_LIMIT', 3_000_000n),

  // liquidate() takes an amountLimit (slippage guard on the vAMM leg). When the
  // ClearingHouse exposes liquidationPriceBandBps, amountLimit is always set to
  // the band edge. These only apply on a deployment without the band:
  // 'zero' disables the guard; 'mark' derives it from the mark price.
  amountLimitMode: (process.env.AMOUNT_LIMIT_MODE || 'zero').trim().toLowerCase(),
  slippageBps: big('SLIPPAGE_BPS', 50n),

  // Profitability
  minLiquidationRewardUsd: float('MIN_LIQUIDATION_REWARD_USD', 10),
  maxGasPriceGwei: float('MAX_GAS_PRICE_GWEI', 50),

  // When false, liquidate anything the simulation accepts, even at a net loss.
  // Reasonable on testnet (gas is free, clearing bad debt is the point); on
  // mainnet this hands value away on every dust position.
  requireProfitable: process.env.REQUIRE_PROFITABLE !== 'false',
  // Gas is paid in ETH but rewards are paid in the quote token. These are GPU
  // compute perps, so a market's mark price says nothing about ETH - the ETH
  // price has to come from outside.
  ethPriceUsd: float('ETH_PRICE_USD', 3000),

  // Funding accrues on every trade and liquidation, so routine pokes are wasted
  // gas. Off by default; when on, only markets with open interest and no trade
  // for FUNDING_POKE_STALE_SEC are poked, at most once per that window.
  fundingPokeEnabled: process.env.FUNDING_POKE_ENABLED === 'true',
  fundingPokeStaleSec: int('FUNDING_POKE_STALE_SEC', 86_400),

  // Position source. When SUPABASE_URL + SUPABASE_KEY are set, open positions are
  // rebuilt (read-only) from canonical_pnl_events written by canonical-indexer.
  // If the indexer checkpoint lags the chain head by more than
  // INDEXER_MAX_LAG_BLOCKS, the bot falls back to its own incremental getLogs.
  supabaseUrl: (process.env.SUPABASE_URL || '').trim(),
  supabaseKey: (process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim(),
  indexerName: (process.env.INDEXER_NAME || 'canonical-pnl-indexer').trim(),
  chainId: int('CHAIN_ID', 11155111),
  indexerMaxLagBlocks: big('INDEXER_MAX_LAG_BLOCKS', 25n),
  supabasePageSize: int('SUPABASE_PAGE_SIZE', 1000),

  // Market metadata (getMarket, marketRiskParams, band, vAMM fee) refresh period.
  marketCacheTtlMs: int('MARKET_CACHE_TTL_MS', 600_000),

  // Failed / skipped liquidations are not retried until the index or mark price
  // moves by more than LIQ_BACKOFF_PRICE_BPS, or LIQ_BACKOFF_CYCLES cycles pass.
  liqBackoffCycles: int('LIQ_BACKOFF_CYCLES', 10),
  liqBackoffPriceBps: big('LIQ_BACKOFF_PRICE_BPS', 50n),

  // Calldata bytes per aggregate3 call. viem's default (1024) splits a 70-position
  // scan into ~10 eth_calls. 16KB is ~120 positions per call, which keeps one
  // eth_call well under the common 50M gas cap. 0 disables splitting.
  multicallBatchBytes: int('MULTICALL_BATCH_BYTES', 16_384),

  rpcStatsIntervalMs: int('RPC_STATS_INTERVAL_MS', 600_000),
  pollingIntervalMs: int('POLLING_INTERVAL_MS', 30_000),

  // RPC resilience
  rpcRetries: int('RPC_RETRIES', 5),
  rpcRetryDelayMs: int('RPC_RETRY_DELAY_MS', 2000),

  // SendGrid
  sendgridApiKey: process.env.SENDGRID_API_KEY || '',
  sendgridFromEmail: process.env.SENDGRID_FROM_EMAIL || 'alerts@bytestrike.com',
  alertRecipientEmail: process.env.ALERT_RECIPIENT_EMAIL || '',
} as const;

export function validateConfig(): void {
  if (!config.rpcUrl) throw new Error('Missing required config: RPC_URL');

  // Copying .env.example without editing it yields a 401 from a URL that looks
  // superficially valid. Catch it here rather than mid-backfill.
  if (/YOUR_ALCHEMY_KEY|YOUR_INFURA|your_api_key|<.*>/i.test(config.rpcUrl)) {
    throw new Error(
      `RPC_URL still contains a placeholder ("${config.rpcUrl}"). Put your real Alchemy/Infura endpoint in .env.`
    );
  }

  if (!config.clearingHouseAddress) throw new Error('Missing required config: CLEARING_HOUSE_ADDRESS');
  if (!config.marketRegistryAddress) throw new Error('Missing required config: MARKET_REGISTRY_ADDRESS');

  if (config.executeMode && !config.privateKey) {
    throw new Error('EXECUTE_MODE is enabled but PRIVATE_KEY is not set');
  }

  if (config.privateKey && !/^0x[0-9a-fA-F]{64}$/.test(config.privateKey)) {
    throw new Error('PRIVATE_KEY must be a 0x-prefixed 32-byte hex key');
  }

  if (!['zero', 'mark'].includes(config.amountLimitMode)) {
    throw new Error(`AMOUNT_LIMIT_MODE must be 'zero' or 'mark' (got '${config.amountLimitMode}')`);
  }

  if (config.sendgridApiKey && !config.alertRecipientEmail) {
    console.warn('SendGrid API key provided but no recipient email configured');
  }

  if (config.executeMode) {
    console.log('⚡ EXECUTION MODE ENABLED - Bot will execute liquidations');
    if (config.dryRun) {
      console.log('🔍 DRY RUN MODE - Transactions will be simulated but not sent');
    }
    if (!config.requireProfitable) {
      console.log('💸 REQUIRE_PROFITABLE=false - liquidating regardless of profit, INCLUDING at a net loss');
    }
  } else {
    console.log('👁️  MONITORING MODE - Bot will only alert, not execute');
  }

  if (config.supabaseUrl && config.supabaseKey) {
    console.log(`Position source: Supabase canonical_pnl_events (fallback getLogs if indexer lags > ${config.indexerMaxLagBlocks} blocks)`);
  } else {
    console.log('Position source: on-chain TradeExecuted logs (SUPABASE_URL/SUPABASE_KEY not set)');
  }
  console.log(`Funding pokes: ${config.fundingPokeEnabled ? `enabled (stale after ${config.fundingPokeStaleSec}s)` : 'disabled'}`);

  if (config.marketIds.size > 0) {
    console.log(`Market filter: ${config.marketIds.size} market(s)`);
  } else {
    console.log('Market filter: none (watching all markets)');
  }
}
