export interface Position {
  size: bigint;
  margin: bigint;
  entryPriceX18: bigint;
  lastFundingIndex: bigint;
  realizedPnL: bigint;
}

export interface TrackedPosition {
  account: `0x${string}`;
  marketId: `0x${string}`;
  position: Position;
  lastChecked: number;
  healthStatus: HealthStatus;
  lastAlertSent?: number;
}

export enum HealthStatus {
  SAFE = 'SAFE',
  WARNING = 'WARNING',  // Between IMR and MMR
  LIQUIDATABLE = 'LIQUIDATABLE',
}

export interface MarginHealth {
  effectiveMargin: bigint;
  maintenanceMargin: bigint;
  initialMargin: bigint;
  marginRatio: number;  // as percentage
  status: HealthStatus;
  unrealizedPnL: bigint;
  notionalValue: bigint;
}

export interface AlertData {
  account: `0x${string}`;
  marketId: `0x${string}`;
  health: MarginHealth;
  position: Position;
  markPrice: bigint;
  timestamp: number;
  executionResult?: 'success' | 'failed' | 'skipped';
}
