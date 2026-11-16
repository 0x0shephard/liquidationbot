// Mirrors IClearingHouse.PositionView (bytestrikecontracts).
// All quote amounts are X18-normalized regardless of the quote token's own decimals.
export interface Position {
  size: bigint; // signed base units (1e18)
  margin: bigint; // quote collateral (1e18)
  entryPriceX18: bigint;
  lastFundingPayIndex: bigint;
  lastFundingReceiveIndex: bigint;
  realizedPnL: bigint;
}

// Mirrors IClearingHouse.MarketRiskParams
export interface MarketRiskParams {
  imrBps: bigint;
  mmrBps: bigint;
  liquidationPenaltyBps: bigint;
  penaltyCap: bigint; // absolute cap in quote units (1e18); 0 = uncapped
  maxPositionSize: bigint;
  minPositionSize: bigint;
}

// Mirrors IMarketRegistry.Market
export interface MarketInfo {
  vamm: `0x${string}`;
  feeBps: number;
  paused: boolean;
  oracle: `0x${string}`;
  feeRouter: `0x${string}`;
  insuranceFund: `0x${string}`;
  baseAsset: `0x${string}`;
  quoteToken: `0x${string}`;
  baseUnit: bigint;
}

export interface TrackedPosition {
  account: `0x${string}`;
  marketId: `0x${string}`;
  size: bigint; // latest newSize from canonical_pnl_events / TradeExecuted
  updatedBlock: bigint;
  lastChecked: number;
  healthStatus: HealthStatus;
}

export enum HealthStatus {
  SAFE = 'SAFE',
  WARNING = 'WARNING', // below IMR, still above MMR
  LIQUIDATABLE = 'LIQUIDATABLE',
}

export interface MarginHealth {
  effectiveMargin: bigint;
  maintenanceMargin: bigint;
  initialMargin: bigint;
  marginRatio: number; // percentage
  status: HealthStatus;
  unrealizedPnL: bigint | null; // null when not computed (size-only position source)
  notionalValue: bigint;
  oraclePriceX18: bigint;
}

export interface AlertData {
  account: `0x${string}`;
  marketId: `0x${string}`;
  health: MarginHealth;
  // Size is known from the position source; entry price only when read on-chain.
  position: Pick<Position, 'size'> & Partial<Pick<Position, 'entryPriceX18'>>;
  timestamp: number;
  executionResult?: 'success' | 'failed' | 'skipped';
}

/** Market metadata refreshed every MARKET_CACHE_TTL_MS. */
export interface MarketMeta {
  info: MarketInfo;
  risk: MarketRiskParams;
  bandBps: bigint | null; // null => ClearingHouse has no liquidationPriceBandBps (pre-upgrade)
  vammFeeBps: bigint | null; // vAMM.feeBps (swap fee on input); null if unreadable
  fetchedAt: number;
}

/** Per-market live reads from the cycle multicall. null = read failed (e.g. stale oracle). */
export interface MarketSnapshot {
  indexPriceX18: bigint | null;
  markPriceX18: bigint | null;
  baseReserve: bigint | null;
  quoteReserve: bigint | null;
}
