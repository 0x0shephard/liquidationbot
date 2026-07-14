import sgMail from '@sendgrid/mail';
import { formatUnits } from 'viem';
import { config } from './config';
import { AlertData, HealthStatus, MarginHealth } from './types';

if (config.sendgridApiKey) {
  sgMail.setApiKey(config.sendgridApiKey);
}

// Rate limiting: one alert per account+market per cooldown window.
const lastAlertTimes = new Map<string, number>();
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

function alertKey(account: string, marketId: string): string {
  return `${account.toLowerCase()}:${marketId.toLowerCase()}`;
}

function shouldSendAlert(account: string, marketId: string): boolean {
  const last = lastAlertTimes.get(alertKey(account, marketId));
  return !last || Date.now() - last > ALERT_COOLDOWN_MS;
}

function recordAlertSent(account: string, marketId: string): void {
  lastAlertTimes.set(alertKey(account, marketId), Date.now());
}

// Quote amounts are X18-normalized on-chain regardless of the token's decimals.
const fmt = (value: bigint): string => formatUnits(value, 18);

function formatHealth(health: MarginHealth): string {
  return `
Margin Health
-------------
Status:              ${health.status}
Margin Ratio:        ${health.marginRatio.toFixed(2)}%
Effective Margin:    ${fmt(health.effectiveMargin)}
Maintenance (MMR):   ${fmt(health.maintenanceMargin)}
Initial (IMR):       ${fmt(health.initialMargin)}
Notional Value:      ${fmt(health.notionalValue)}
Unrealized PnL:      ${fmt(health.unrealizedPnL)}
`;
}

function statusEmoji(status: HealthStatus): string {
  switch (status) {
    case HealthStatus.SAFE:
      return '✅';
    case HealthStatus.WARNING:
      return '⚠️';
    case HealthStatus.LIQUIDATABLE:
      return '🚨';
  }
}

function alertSubject(status: HealthStatus, account: string): string {
  const short = `${account.slice(0, 6)}...${account.slice(-4)}`;
  switch (status) {
    case HealthStatus.WARNING:
      return `⚠️ ByteStrike: Position at Risk - ${short}`;
    case HealthStatus.LIQUIDATABLE:
      return `🚨 URGENT: Position Liquidatable - ${short}`;
    default:
      return `ByteStrike Position Alert - ${short}`;
  }
}

function buildBody(data: AlertData): string {
  const emoji = statusEmoji(data.health.status);
  const direction = data.position.size > 0n ? 'LONG' : 'SHORT';
  const absSize = data.position.size < 0n ? -data.position.size : data.position.size;

  const guidance =
    data.health.status === HealthStatus.WARNING
      ? `
⚠️ Position is below the Initial Margin Requirement but still above Maintenance Margin.
   - Add collateral, or reduce position size.
   - Further adverse price movement could trigger liquidation.
`
      : data.health.status === HealthStatus.LIQUIDATABLE
        ? `
🚨 Position is below the Maintenance Margin Requirement and can be liquidated now.
   - Add collateral immediately to avoid liquidation.
`
        : '';

  const execution = data.executionResult
    ? `\nLiquidation attempt: ${data.executionResult.toUpperCase()}\n`
    : '';

  return `
${emoji} ByteStrike Position Alert ${emoji}

Account:  ${data.account}
Market:   ${data.marketId}
Time:     ${new Date(data.timestamp).toISOString()}

Position
--------
Size:          ${fmt(absSize)} (${direction})
Entry Price:   ${fmt(data.position.entryPriceX18)}
Oracle Price:  ${fmt(data.health.oraclePriceX18)}
${formatHealth(data.health)}${guidance}${execution}
---
Automated alert from the ByteStrike Liquidation Bot.
Network: Sepolia Testnet
`;
}

export async function sendEmailAlert(data: AlertData): Promise<void> {
  if (!config.sendgridApiKey || !config.alertRecipientEmail) {
    logAlert(data);
    return;
  }

  if (!shouldSendAlert(data.account, data.marketId)) {
    console.log(`Skipping alert for ${data.account.slice(0, 10)}... (rate limited)`);
    return;
  }

  try {
    await sgMail.send({
      to: config.alertRecipientEmail,
      from: config.sendgridFromEmail,
      subject: alertSubject(data.health.status, data.account),
      text: buildBody(data),
    });
    recordAlertSent(data.account, data.marketId);
    console.log(`Email alert sent for ${data.account.slice(0, 10)}... (${data.health.status})`);
  } catch (error) {
    console.error('Failed to send email alert:', error);
    logAlert(data);
  }
}

export function logAlert(data: AlertData): void {
  const short = `${data.account.slice(0, 6)}...${data.account.slice(-4)}`;
  console.log('\n' + '='.repeat(60));
  console.log(`${statusEmoji(data.health.status)} POSITION ALERT - ${short}`);
  console.log('='.repeat(60));
  console.log(`Account: ${data.account}`);
  console.log(`Market:  ${data.marketId}`);
  console.log(formatHealth(data.health));
  console.log('='.repeat(60) + '\n');
}

export async function sendTestEmail(): Promise<boolean> {
  if (!config.sendgridApiKey || !config.alertRecipientEmail) {
    console.log('Email not configured');
    return false;
  }

  try {
    await sgMail.send({
      to: config.alertRecipientEmail,
      from: config.sendgridFromEmail,
      subject: 'ByteStrike Monitor - Test Email',
      text: 'Test email from the ByteStrike Liquidation Bot. Email alerts are working.',
    });
    console.log('Test email sent successfully');
    return true;
  } catch (error) {
    console.error('Failed to send test email:', error);
    return false;
  }
}
