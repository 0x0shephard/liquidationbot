import { config, validateConfig } from './config';
import { initializeTracker, trackSpecificAccount, getTrackerStats } from './tracker';
import { startMonitoring, stopMonitoring, logMarketStatus } from './monitor';
import { sendTestEmail } from './notifications';
import { getCurrentBlockNumber } from './blockchain';

async function main() {
  console.log('='.repeat(60));
  console.log('ByteStrike Liquidation Monitor Bot');
  console.log('='.repeat(60));
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log(`Network: Sepolia Testnet`);
  console.log(`Polling Interval: ${config.pollingIntervalMs}ms`);
  console.log(`IMR: ${config.imrBps / 100}% | MMR: ${config.mmrBps / 100}%`);
  console.log('='.repeat(60));

  try {
    // Validate configuration
    validateConfig();
    console.log('Configuration validated');

    // Test blockchain connection
    const currentBlock = await getCurrentBlockNumber();
    console.log(`Connected to blockchain. Current block: ${currentBlock}`);

    // Log current market status
    await logMarketStatus();

    // Send test email if configured
    if (config.sendgridApiKey && config.alertRecipientEmail) {
      console.log('Testing email configuration...');
      const emailWorks = await sendTestEmail();
      if (!emailWorks) {
        console.warn('Email alerts may not work. Check your SendGrid configuration.');
      }
    } else {
      console.log('Email alerts not configured. Using console logging only.');
    }

    // Initialize tracker with historical events
    await initializeTracker(50000); // Look back 50k blocks (~1 week on Sepolia)

    const stats = getTrackerStats();
    console.log(`\nInitial stats: ${stats.total} positions tracked`);
    console.log(`  Safe: ${stats.safe}`);
    console.log(`  Warning: ${stats.warning}`);
    console.log(`  Liquidatable: ${stats.liquidatable}`);

    // Option to track specific accounts (add your accounts here)
    // Uncomment and add addresses you want to monitor specifically
    // await trackSpecificAccount('0xYourAddress...');

    // Start the monitoring loop
    startMonitoring();

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\nReceived SIGINT. Shutting down...');
      stopMonitoring();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.log('\nReceived SIGTERM. Shutting down...');
      stopMonitoring();
      process.exit(0);
    });

    console.log('\nBot is running. Press Ctrl+C to stop.');
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// CLI argument handling
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
ByteStrike Liquidation Monitor Bot

Usage:
  npm run dev              Start the bot in development mode
  npm run start            Start the bot (requires build first)
  npm run build            Build TypeScript to JavaScript

Environment Variables (see .env.example):
  RPC_URL                  Ethereum RPC endpoint
  CLEARING_HOUSE_ADDRESS   ClearingHouse contract address
  VAMM_ADDRESS             vAMM contract address
  ORACLE_ADDRESS           Oracle contract address
  MARKET_ID                Market ID to monitor
  SENDGRID_API_KEY         SendGrid API key for email alerts
  SENDGRID_FROM_EMAIL      Email sender address
  ALERT_RECIPIENT_EMAIL    Email recipient for alerts
  POLLING_INTERVAL_MS      How often to check positions (default: 30000)

Features:
  - Monitors all positions in the specified market
  - Automatically tracks new positions via event indexing
  - Sends email alerts when positions enter WARNING zone (below IMR, above MMR)
  - Sends URGENT alerts when positions become LIQUIDATABLE (below MMR)
  - Rate-limited alerts (5 min cooldown per account)
  - Console logging for all status changes

Alert Zones:
  - SAFE: Effective margin >= Initial Margin Requirement (IMR)
  - WARNING: MMR <= Effective margin < IMR (at risk of liquidation)
  - LIQUIDATABLE: Effective margin < Maintenance Margin (can be liquidated)
`);
  process.exit(0);
}

if (args.includes('--test-email')) {
  (async () => {
    validateConfig();
    const success = await sendTestEmail();
    process.exit(success ? 0 : 1);
  })();
} else if (args.includes('--track')) {
  const addressIndex = args.indexOf('--track') + 1;
  if (addressIndex < args.length) {
    const address = args[addressIndex] as `0x${string}`;
    (async () => {
      validateConfig();
      await initializeTracker(1000);
      await trackSpecificAccount(address);
      startMonitoring();
    })();
  } else {
    console.error('Please provide an address after --track');
    process.exit(1);
  }
} else {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
