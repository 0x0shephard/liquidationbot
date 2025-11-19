import { TrackedPosition, HealthStatus } from './types';
import { getPosition, calculateMarginHealth, getPositionOpenedEvents, getPositionClosedEvents, getCurrentBlockNumber } from './blockchain';
import { config } from './config';

// In-memory position tracker
// In production, consider using Redis or a database
const trackedPositions: Map<string, TrackedPosition> = new Map();
let lastProcessedBlock: bigint = 0n;

function getPositionKey(account: `0x${string}`, marketId: `0x${string}`): string {
  return `${account.toLowerCase()}-${marketId.toLowerCase()}`;
}

export async function addPosition(account: `0x${string}`, marketId: `0x${string}`): Promise<TrackedPosition | null> {
  const key = getPositionKey(account, marketId);

  // Get current position data
  const position = await getPosition(account, marketId);

  // Skip if no position
  if (position.size === 0n) {
    trackedPositions.delete(key);
    return null;
  }

  const health = await calculateMarginHealth(account, marketId);

  const tracked: TrackedPosition = {
    account,
    marketId,
    position,
    lastChecked: Date.now(),
    healthStatus: health.status,
  };

  trackedPositions.set(key, tracked);
  console.log(`Tracking position for ${account} in market ${marketId.slice(0, 10)}...`);

  return tracked;
}

export function removePosition(account: `0x${string}`, marketId: `0x${string}`): void {
  const key = getPositionKey(account, marketId);
  trackedPositions.delete(key);
  console.log(`Stopped tracking position for ${account}`);
}

export function getAllTrackedPositions(): TrackedPosition[] {
  return Array.from(trackedPositions.values());
}

export function getTrackedPosition(account: `0x${string}`, marketId: `0x${string}`): TrackedPosition | undefined {
  const key = getPositionKey(account, marketId);
  return trackedPositions.get(key);
}

export function updateTrackedPosition(account: `0x${string}`, marketId: `0x${string}`, updates: Partial<TrackedPosition>): void {
  const key = getPositionKey(account, marketId);
  const existing = trackedPositions.get(key);

  if (existing) {
    trackedPositions.set(key, { ...existing, ...updates });
  }
}

// Initialize tracker by scanning historical events
export async function initializeTracker(lookbackBlocks: number = 10000): Promise<void> {
  console.log('Initializing position tracker...');

  const currentBlock = await getCurrentBlockNumber();
  const fromBlock = currentBlock - BigInt(lookbackBlocks);

  console.log(`Scanning blocks ${fromBlock} to ${currentBlock} for position events...`);

  // Get all position opened events
  const openedEvents = await getPositionOpenedEvents(fromBlock, currentBlock);
  console.log(`Found ${openedEvents.length} PositionOpened events`);

  // Track unique accounts
  const uniquePositions = new Map<string, { account: `0x${string}`; marketId: `0x${string}` }>();

  for (const event of openedEvents) {
    const key = getPositionKey(event.account, event.marketId);
    uniquePositions.set(key, event);
  }

  // Check closed events to see if positions are still open
  const closedEvents = await getPositionClosedEvents(fromBlock, currentBlock);
  console.log(`Found ${closedEvents.length} PositionClosed events`);

  for (const event of closedEvents) {
    if (event.remainingSize === 0n) {
      const key = getPositionKey(event.account, event.marketId);
      uniquePositions.delete(key);
    }
  }

  // Add remaining open positions
  console.log(`Tracking ${uniquePositions.size} active positions`);

  for (const { account, marketId } of uniquePositions.values()) {
    await addPosition(account, marketId);
  }

  lastProcessedBlock = currentBlock;
  console.log('Tracker initialization complete');
}

// Update tracker with new events
export async function syncNewEvents(): Promise<void> {
  const currentBlock = await getCurrentBlockNumber();

  if (currentBlock <= lastProcessedBlock) {
    return;
  }

  const fromBlock = lastProcessedBlock + 1n;

  // Get new opened positions
  const openedEvents = await getPositionOpenedEvents(fromBlock, currentBlock);
  for (const event of openedEvents) {
    await addPosition(event.account, event.marketId);
  }

  // Check for closed positions
  const closedEvents = await getPositionClosedEvents(fromBlock, currentBlock);
  for (const event of closedEvents) {
    if (event.remainingSize === 0n) {
      removePosition(event.account, event.marketId);
    } else {
      // Position still open but reduced, update it
      await addPosition(event.account, event.marketId);
    }
  }

  lastProcessedBlock = currentBlock;
}

// Manual position tracking (for specific accounts)
export async function trackSpecificAccount(account: `0x${string}`): Promise<void> {
  console.log(`Manually tracking account ${account} for market ${config.marketId.slice(0, 10)}...`);
  await addPosition(account, config.marketId);
}

export function getTrackerStats(): { total: number; safe: number; warning: number; liquidatable: number } {
  const positions = getAllTrackedPositions();

  return {
    total: positions.length,
    safe: positions.filter(p => p.healthStatus === HealthStatus.SAFE).length,
    warning: positions.filter(p => p.healthStatus === HealthStatus.WARNING).length,
    liquidatable: positions.filter(p => p.healthStatus === HealthStatus.LIQUIDATABLE).length,
  };
}
