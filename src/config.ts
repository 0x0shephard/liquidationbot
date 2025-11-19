import dotenv from 'dotenv';

dotenv.config();

export const config = {
  // RPC
  rpcUrl: process.env.RPC_URL || 'https://eth-sepolia.g.alchemy.com/v2/demo',

  // Contract Addresses
  clearingHouseAddress: process.env.CLEARING_HOUSE_ADDRESS as `0x${string}` || '0x445Fa8890562Ec6220A60b3911C692DffaD49AcB',
  vammAddress: process.env.VAMM_ADDRESS as `0x${string}` || '0x3f9b634b9f09e7F8e84348122c86d3C2324841b5',
  oracleAddress: process.env.ORACLE_ADDRESS as `0x${string}` || '0x3cA2Da03e4b6dB8fe5a24c22Cf5EB2A34B59cbad',
  marketRegistryAddress: process.env.MARKET_REGISTRY_ADDRESS as `0x${string}` || '0x937F40013B088832919992E0Bd0D0F48520dC964',

  // Market ID
  marketId: process.env.MARKET_ID as `0x${string}` || '0x385badc5603eb47056a6bdcd6ac81a50df49d7a4e8a7451405e580bd12087a28',

  // Execution Settings
  privateKey: process.env.PRIVATE_KEY as `0x${string}` || '',
  executeMode: process.env.EXECUTE_MODE === 'true',

  // SendGrid
  sendgridApiKey: process.env.SENDGRID_API_KEY || '',
  sendgridFromEmail: process.env.SENDGRID_FROM_EMAIL || 'alerts@bytestrike.com',
  alertRecipientEmail: process.env.ALERT_RECIPIENT_EMAIL || '',

  // Bot Settings
  pollingIntervalMs: parseInt(process.env.POLLING_INTERVAL_MS || '30000'),
  warningThresholdBuffer: parseFloat(process.env.WARNING_THRESHOLD_BUFFER || '0.1'),
  fundingPokeIntervalMs: parseInt(process.env.FUNDING_POKE_INTERVAL_MS || '3600000'), // 1 hour default

  // Execution Parameters
  minLiquidationRewardUsd: parseFloat(process.env.MIN_LIQUIDATION_REWARD_USD || '10'),
  maxGasPriceGwei: parseFloat(process.env.MAX_GAS_PRICE_GWEI || '50'),
  dryRun: process.env.DRY_RUN === 'true',

  // Risk Parameters (matching BaseTest.sol defaults)
  imrBps: 1000, // 10% Initial Margin Requirement
  mmrBps: 250,  // 2.5% Maintenance Margin Requirement
} as const;

export function validateConfig(): void {
  const required = [
    'rpcUrl',
    'clearingHouseAddress',
    'vammAddress',
    'marketId',
  ];

  for (const key of required) {
    if (!config[key as keyof typeof config]) {
      throw new Error(`Missing required config: ${key}`);
    }
  }

  if (config.executeMode && !config.privateKey) {
    throw new Error('EXECUTE_MODE is enabled but PRIVATE_KEY is not set');
  }

  if (config.privateKey && !config.privateKey.startsWith('0x')) {
    throw new Error('PRIVATE_KEY must start with 0x');
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
}
