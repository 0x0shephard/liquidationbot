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

  // Earliest Sepolia deployment receipt. Raise this to speed up bootstrap.
  startBlock: big('START_BLOCK', 10_797_215n),
  logChunkSize: big('LOG_CHUNK_SIZE', 10_000n),

  // Execution
  privateKey: (process.env.PRIVATE_KEY as `0x${string}`) || '',
  executeMode: process.env.EXECUTE_MODE === 'true',
  dryRun: process.env.DRY_RUN === 'true',
  gasLimit: big('GAS_LIMIT', 900_000n),

  // liquidate() takes an amountLimit (slippage guard on the vAMM leg).
  // 'zero' disables the guard; 'mark' derives it from the mark price.
  amountLimitMode: (process.env.AMOUNT_LIMIT_MODE || 'zero').trim().toLowerCase(),
  slippageBps: big('SLIPPAGE_BPS', 50n),

  // Profitability
  minLiquidationRewardUsd: float('MIN_LIQUIDATION_REWARD_USD', 10),
  maxGasPriceGwei: float('MAX_GAS_PRICE_GWEI', 50),
  // Gas is paid in ETH but rewards are paid in the quote token. These are GPU
  // compute perps, so a market's mark price says nothing about ETH - the ETH
  // price has to come from outside.
  ethPriceUsd: float('ETH_PRICE_USD', 3000),

  fundingPokeIntervalMs: int('FUNDING_POKE_INTERVAL_MS', 3_600_000),
  pollingIntervalMs: int('POLLING_INTERVAL_MS', 30_000),
  maxPositionsPerScan: int('MAX_POSITIONS_PER_SCAN', 250),

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
  } else {
    console.log('👁️  MONITORING MODE - Bot will only alert, not execute');
  }

  if (config.marketIds.size > 0) {
    console.log(`Market filter: ${config.marketIds.size} market(s)`);
  } else {
    console.log('Market filter: none (watching all markets)');
  }
}
