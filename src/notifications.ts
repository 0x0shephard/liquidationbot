import sgMail from '@sendgrid/mail';
import { config } from './config';
import { AlertData, HealthStatus, MarginHealth } from './types';
import { formatUnits } from 'viem';

// Initialize SendGrid
if (config.sendgridApiKey) {
  sgMail.setApiKey(config.sendgridApiKey);
}

// Rate limiting: track last alert time per account
const lastAlertTimes: Map<string, number> = new Map();
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

function shouldSendAlert(account: `0x${string}`): boolean {
  const lastSent = lastAlertTimes.get(account.toLowerCase());

  if (!lastSent) {
    return true;
  }

  return Date.now() - lastSent > ALERT_COOLDOWN_MS;
}

function recordAlertSent(account: `0x${string}`): void {
  lastAlertTimes.set(account.toLowerCase(), Date.now());
}

function formatBigInt(value: bigint, decimals: number = 18): string {
  return formatUnits(value, decimals);
}

function formatHealth(health: MarginHealth): string {
  const effectiveMarginStr = formatBigInt(health.effectiveMargin);
  const mmrStr = formatBigInt(health.maintenanceMargin);
  const imrStr = formatBigInt(health.initialMargin);
  const notionalStr = formatBigInt(health.notionalValue);
  const pnlStr = formatBigInt(health.unrealizedPnL);

  return `
Margin Health Report:
---------------------
Status: ${health.status}
Margin Ratio: ${health.marginRatio.toFixed(2)}%
Effective Margin: ${effectiveMarginStr} USDC
Maintenance Margin (MMR): ${mmrStr} USDC
Initial Margin (IMR): ${imrStr} USDC
Notional Value: ${notionalStr} USDC
Unrealized PnL: ${pnlStr} USDC
`;
}

function getStatusEmoji(status: HealthStatus): string {
  switch (status) {
    case HealthStatus.SAFE:
      return '✅';
    case HealthStatus.WARNING:
      return '⚠️';
    case HealthStatus.LIQUIDATABLE:
      return '🚨';
  }
}

function getAlertSubject(status: HealthStatus, account: string): string {
  const shortAccount = `${account.slice(0, 6)}...${account.slice(-4)}`;

  switch (status) {
    case HealthStatus.WARNING:
      return `⚠️ ByteStrike: Position at Risk - ${shortAccount}`;
    case HealthStatus.LIQUIDATABLE:
      return `🚨 URGENT: Position Liquidatable - ${shortAccount}`;
    default:
      return `ByteStrike Position Alert - ${shortAccount}`;
  }
}

export async function sendEmailAlert(data: AlertData): Promise<void> {
  if (!config.sendgridApiKey || !config.alertRecipientEmail) {
    console.log('Email alerts not configured, logging to console:');
    logAlert(data);
    return;
  }

  if (!shouldSendAlert(data.account)) {
    console.log(`Skipping alert for ${data.account} (rate limited)`);
    return;
  }

  const shortAccount = `${data.account.slice(0, 6)}...${data.account.slice(-4)}`;
  const markPriceStr = formatBigInt(data.markPrice);
  const entryPriceStr = formatBigInt(data.position.entryPriceX18);
  const sizeStr = formatBigInt(BigInt(data.position.size));

  const emailBody = `
${getStatusEmoji(data.health.status)} ByteStrike Position Alert ${getStatusEmoji(data.health.status)}

Account: ${data.account}
Market ID: ${data.marketId}
Time: ${new Date(data.timestamp).toISOString()}

Position Details:
-----------------
Size: ${sizeStr} ETH (${data.position.size > 0n ? 'LONG' : 'SHORT'})
Entry Price: $${entryPriceStr}
Current Mark Price: $${markPriceStr}

${formatHealth(data.health)}

${data.health.status === HealthStatus.WARNING ? `
⚠️ WARNING: Your position is below the Initial Margin Requirement (IMR) but above Maintenance Margin (MMR).

ACTION REQUIRED:
- Consider adding more collateral to increase your margin
- Or reduce your position size to lower risk
- Monitor closely as further price movement could trigger liquidation
` : ''}

${data.health.status === HealthStatus.LIQUIDATABLE ? `
🚨 CRITICAL: Your position is BELOW the Maintenance Margin Requirement (MMR) and is at immediate risk of liquidation!

URGENT ACTION REQUIRED:
- Add collateral IMMEDIATELY to avoid liquidation
- Your position could be liquidated at any moment
- Visit the ByteStrike dApp now to manage your position
` : ''}

---
This is an automated alert from ByteStrike Liquidation Monitor Bot.
Network: Sepolia Testnet
`;

  const msg = {
    to: config.alertRecipientEmail,
    from: config.sendgridFromEmail,
    subject: getAlertSubject(data.health.status, data.account),
    text: emailBody,
  };

  try {
    await sgMail.send(msg);
    recordAlertSent(data.account);
    console.log(`Email alert sent for ${shortAccount} - Status: ${data.health.status}`);
  } catch (error) {
    console.error('Failed to send email alert:', error);
    // Fallback to console
    logAlert(data);
  }
}

export function logAlert(data: AlertData): void {
  const shortAccount = `${data.account.slice(0, 6)}...${data.account.slice(-4)}`;

  console.log('\n' + '='.repeat(60));
  console.log(`${getStatusEmoji(data.health.status)} POSITION ALERT - ${shortAccount}`);
  console.log('='.repeat(60));
  console.log(`Status: ${data.health.status}`);
  console.log(`Account: ${data.account}`);
  console.log(`Market: ${data.marketId.slice(0, 10)}...`);
  console.log(`Time: ${new Date(data.timestamp).toISOString()}`);
  console.log(formatHealth(data.health));
  console.log('='.repeat(60) + '\n');
}

export async function sendTestEmail(): Promise<boolean> {
  if (!config.sendgridApiKey || !config.alertRecipientEmail) {
    console.log('Email not configured');
    return false;
  }

  const msg = {
    to: config.alertRecipientEmail,
    from: config.sendgridFromEmail,
    subject: 'ByteStrike Monitor - Test Email',
    text: 'This is a test email from ByteStrike Liquidation Monitor Bot. If you receive this, email alerts are working correctly.',
  };

  try {
    await sgMail.send(msg);
    console.log('Test email sent successfully');
    return true;
  } catch (error) {
    console.error('Failed to send test email:', error);
    return false;
  }
}
