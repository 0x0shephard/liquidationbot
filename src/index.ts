import { formatEther } from 'viem';
import { config, validateConfig } from './config';
import { initializeTracker, trackSpecificAccount, getAllTrackedPositions, getTrackerStats } from './tracker';
import { startMonitoring, stopMonitoring, logMarketStatus } from './monitor';
import { sendTestEmail } from './notifications';
import {
  getCurrentBlockNumber,
  getLiquidatorAddress,
  isWhitelistedLiquidator,
  publicClient,
} from './blockchain';

const HELP = `
ByteStrike Liquidation Bot (Sepolia)

Usage:
  npm run dev                          Start in development mode
  npm run build && npm run start       Start from a build
  npm run dev -- --address             Print the liquidator address + whitelist status
  npm run dev -- --test-email          Send a test email and exit
  npm run dev -- --track <addr> <mkt>  Also track a specific account/market
  npm run dev -- --help                Show this help

Key environment variables (see .env.example):
  RPC_URL                     Sepolia RPC endpoint
  CLEARING_HOUSE_ADDRESS      ClearingHouse proxy (defaults to the live deployment)
  MARKET_REGISTRY_ADDRESS     MarketRegistry (defaults to the live deployment)
  MARKET_IDS                  Comma-separated market allowlist (default: all markets)
  START_BLOCK                 First block to index (default: 10797215, the deploy block)
  EXECUTE_MODE                'true' to execute liquidations (default: monitor only)
  DRY_RUN                     'true' to simulate and price, but never send
  PRIVATE_KEY                 Liquidator key; must be whitelisted on-chain
  MIN_LIQUIDATION_REWARD_USD  Minimum net profit to execute (default: 10)
  MAX_GAS_PRICE_GWEI          Skip when gas exceeds this (default: 50)
  ETH_PRICE_USD               ETH price used to cost gas (default: 3000)
  AMOUNT_LIMIT_MODE           'zero' (no slippage guard) or 'mark' (default: zero)

Positions are discovered from TradeExecuted logs, whose newSize field covers
opens, resizes, closes and liquidations. Per-market vAMM, oracle and feeRouter
addresses are resolved from the MarketRegistry at runtime.
`;

async function preflight(): Promise<void> {
  const block = await getCurrentBlockNumber();
  console.log(`Connected to Sepolia at block ${block}`);

  if (!config.executeMode) return;

  const liquidator = getLiquidatorAddress();
  if (!liquidator) throw new Error('EXECUTE_MODE is enabled but no wallet could be derived');

  const balance = await publicClient.getBalance({ address: liquidator });
  console.log(`Liquidator: ${liquidator}`);
  console.log(`Balance:    ${formatEther(balance)} ETH`);

  // liquidate() is behind onlyWhitelistedLiquidator; without this every attempt
  // burns a simulation and reverts. Fail loudly at startup instead.
  const whitelisted = await isWhitelistedLiquidator(liquidator);
  console.log(`Whitelisted: ${whitelisted}`);

  if (!whitelisted) {
    throw new Error(
      `${liquidator} is not a whitelisted liquidator. An admin must call ` +
        `setWhitelistedLiquidator(${liquidator}, true) on the ClearingHouse.`
    );
  }

  if (balance === 0n) {
    console.warn('⚠️  Liquidator wallet has no ETH - transactions will fail.');
  }
}

async function main(trackTarget?: { account: `0x${string}`; marketId: `0x${string}` }) {
  console.log('='.repeat(60));
  console.log('ByteStrike Liquidation Bot');
  console.log('='.repeat(60));
  console.log(`Started:       ${new Date().toISOString()}`);
  console.log(`Network:       Sepolia (11155111)`);
  console.log(`ClearingHouse: ${config.clearingHouseAddress}`);
  console.log(`Registry:      ${config.marketRegistryAddress}`);
  console.log(`Poll interval: ${config.pollingIntervalMs}ms`);
  console.log('='.repeat(60));

  validateConfig();
  await preflight();

  if (config.sendgridApiKey && config.alertRecipientEmail) {
    if (!(await sendTestEmail())) {
      console.warn('Email alerts may not work. Check your SendGrid configuration.');
    }
  } else {
    console.log('Email alerts not configured - logging to console only.');
  }

  await initializeTracker();

  if (trackTarget) {
    await trackSpecificAccount(trackTarget.account, trackTarget.marketId);
  }

  const stats = getTrackerStats();
  console.log(`\nTracking ${stats.total} position(s)`);

  const markets = [...new Set(getAllTrackedPositions().map((p) => p.marketId))];
  await logMarketStatus(markets);

  startMonitoring();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`\nReceived ${signal}. Shutting down...`);
      stopMonitoring();
      process.exit(0);
    });
  }

  console.log('\nBot is running. Press Ctrl+C to stop.');
}

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(HELP);
  process.exit(0);
} else if (args.includes('--address')) {
  // The bot has no identity of its own: its address is derived from PRIVATE_KEY.
  (async () => {
    const liquidator = getLiquidatorAddress();
    if (!liquidator) {
      console.error('No PRIVATE_KEY set, so no liquidator address exists yet.');
      console.error('Generate a dedicated wallet (e.g. `cast wallet new`), put the key in .env, then re-run.');
      process.exit(1);
    }

    // The address comes from the key alone, so print it before touching the
    // network - a broken RPC must not stop you from learning what to whitelist.
    console.log(`Liquidator address: ${liquidator}`);

    let whitelisted = false;
    try {
      const [balance, isWhitelisted] = await Promise.all([
        publicClient.getBalance({ address: liquidator }),
        isWhitelistedLiquidator(liquidator),
      ]);
      whitelisted = isWhitelisted;

      console.log(`Balance:            ${formatEther(balance)} ETH`);
      console.log(`Whitelisted:        ${whitelisted ? 'yes' : 'NO'}`);
    } catch (error: any) {
      console.warn(`\n⚠️  Could not reach the RPC, so balance and whitelist status are unknown.`);
      console.warn(`   ${error.shortMessage || error.message}`);
      console.warn(`   The address above is still correct - it is derived from PRIVATE_KEY alone.`);
    }

    if (!whitelisted) {
      console.log(`\nTo whitelist, an admin must call on the ClearingHouse (${config.clearingHouseAddress}):`);
      console.log(`  setWhitelistedLiquidator(${liquidator}, true)`);
    }
    process.exit(0);
  })();
} else if (args.includes('--test-email')) {
  (async () => {
    validateConfig();
    process.exit((await sendTestEmail()) ? 0 : 1);
  })();
} else if (args.includes('--track')) {
  const i = args.indexOf('--track');
  const account = args[i + 1] as `0x${string}` | undefined;
  const marketId = args[i + 2] as `0x${string}` | undefined;

  if (!account || !marketId) {
    console.error('Usage: --track <account> <marketId>');
    process.exit(1);
  }

  main({ account, marketId }).catch((error) => {
    console.error('Fatal error:', error.shortMessage || error.message || error);
    process.exit(1);
  });
} else {
  main().catch((error) => {
    console.error('Fatal error:', error.shortMessage || error.message || error);
    process.exit(1);
  });
}
