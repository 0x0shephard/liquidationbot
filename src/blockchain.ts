import { createPublicClient, createWalletClient, http, parseAbiItem } from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from './config';
import { clearingHouseAbi, vammAbi, oracleAbi } from './abis';
import { Position, MarginHealth, HealthStatus } from './types';

// Create viem public client (read-only)
export const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(config.rpcUrl),
});

// Create wallet client (for transactions) - only if private key is provided
export const walletClient = config.privateKey
  ? createWalletClient({
      account: privateKeyToAccount(config.privateKey),
      chain: sepolia,
      transport: http(config.rpcUrl),
    })
  : null;

// Get liquidator address
export function getLiquidatorAddress(): `0x${string}` | null {
  return walletClient?.account?.address || null;
}

// Contract read helpers
export async function getPosition(account: `0x${string}`, marketId: `0x${string}`): Promise<Position> {
  const result = await publicClient.readContract({
    address: config.clearingHouseAddress,
    abi: clearingHouseAbi,
    functionName: 'getPosition',
    args: [account, marketId],
  });

  return {
    size: result.size,
    margin: result.margin,
    entryPriceX18: result.entryPriceX18,
    lastFundingIndex: result.lastFundingIndex,
    realizedPnL: result.realizedPnL,
  };
}

export async function isLiquidatable(account: `0x${string}`, marketId: `0x${string}`): Promise<boolean> {
  return await publicClient.readContract({
    address: config.clearingHouseAddress,
    abi: clearingHouseAbi,
    functionName: 'isLiquidatable',
    args: [account, marketId],
  });
}

export async function getMaintenanceMargin(account: `0x${string}`, marketId: `0x${string}`): Promise<bigint> {
  return await publicClient.readContract({
    address: config.clearingHouseAddress,
    abi: clearingHouseAbi,
    functionName: 'getMaintenanceMargin',
    args: [account, marketId],
  });
}

export async function getMarkPrice(): Promise<bigint> {
  return await publicClient.readContract({
    address: config.vammAddress,
    abi: vammAbi,
    functionName: 'getMarkPrice',
  });
}

export async function getOraclePrice(symbol: string = 'ETH'): Promise<bigint> {
  return await publicClient.readContract({
    address: config.oracleAddress,
    abi: oracleAbi,
    functionName: 'getPrice',
    args: [symbol],
  });
}

export async function getCumulativeFunding(): Promise<bigint> {
  return await publicClient.readContract({
    address: config.vammAddress,
    abi: vammAbi,
    functionName: 'cumulativeFundingPerUnitX18',
  });
}

// Calculate margin health for a position
export async function calculateMarginHealth(
  account: `0x${string}`,
  marketId: `0x${string}`
): Promise<MarginHealth> {
  const [position, markPrice, maintenanceMargin, liquidatable] = await Promise.all([
    getPosition(account, marketId),
    getMarkPrice(),
    getMaintenanceMargin(account, marketId),
    isLiquidatable(account, marketId),
  ]);

  // If no position exists
  if (position.size === 0n) {
    return {
      effectiveMargin: 0n,
      maintenanceMargin: 0n,
      initialMargin: 0n,
      marginRatio: 0,
      status: HealthStatus.SAFE,
      unrealizedPnL: 0n,
      notionalValue: 0n,
    };
  }

  // Calculate unrealized PnL
  // For longs: (markPrice - entryPrice) * size / 1e18
  // For shorts: (entryPrice - markPrice) * |size| / 1e18
  const absSize = position.size < 0n ? -position.size : position.size;
  let unrealizedPnL: bigint;

  if (position.size > 0n) {
    // Long position
    unrealizedPnL = ((markPrice - position.entryPriceX18) * position.size) / BigInt(1e18);
  } else {
    // Short position
    unrealizedPnL = ((position.entryPriceX18 - markPrice) * absSize) / BigInt(1e18);
  }

  // Effective margin = stored margin + unrealized PnL
  const effectiveMargin = BigInt(position.margin) + unrealizedPnL;

  // Calculate notional value
  const notionalValue = (absSize * markPrice) / BigInt(1e18);

  // Calculate initial margin requirement
  const initialMargin = (notionalValue * BigInt(config.imrBps)) / 10000n;

  // Determine health status
  let status: HealthStatus;
  if (liquidatable || effectiveMargin < maintenanceMargin) {
    status = HealthStatus.LIQUIDATABLE;
  } else if (effectiveMargin < initialMargin) {
    status = HealthStatus.WARNING;
  } else {
    status = HealthStatus.SAFE;
  }

  // Calculate margin ratio as percentage
  // marginRatio = effectiveMargin / notionalValue * 100
  const marginRatio = notionalValue > 0n
    ? Number((effectiveMargin * 10000n) / notionalValue) / 100
    : 0;

  return {
    effectiveMargin,
    maintenanceMargin,
    initialMargin,
    marginRatio,
    status,
    unrealizedPnL,
    notionalValue,
  };
}

// Watch for position events to track new positions
export async function getPositionOpenedEvents(fromBlock: bigint, toBlock: bigint): Promise<Array<{ account: `0x${string}`; marketId: `0x${string}` }>> {
  const logs = await publicClient.getLogs({
    address: config.clearingHouseAddress,
    event: parseAbiItem('event PositionOpened(bytes32 indexed marketId, address indexed account, int128 sizeDelta, int128 newSize, uint256 avgEntryPriceX18, uint256 newMarginReq)'),
    fromBlock,
    toBlock,
  });

  return logs.map((log) => ({
    account: log.args.account as `0x${string}`,
    marketId: log.args.marketId as `0x${string}`,
  }));
}

export async function getPositionClosedEvents(fromBlock: bigint, toBlock: bigint): Promise<Array<{ account: `0x${string}`; marketId: `0x${string}`; remainingSize: bigint }>> {
  const logs = await publicClient.getLogs({
    address: config.clearingHouseAddress,
    event: parseAbiItem('event PositionClosed(bytes32 indexed marketId, address indexed account, uint128 sizeClosed, int128 remainingSize, int256 realizedPnL, uint256 feesPaid)'),
    fromBlock,
    toBlock,
  });

  return logs.map((log) => ({
    account: log.args.account as `0x${string}`,
    marketId: log.args.marketId as `0x${string}`,
    remainingSize: log.args.remainingSize as bigint,
  }));
}

export async function getCurrentBlockNumber(): Promise<bigint> {
  return await publicClient.getBlockNumber();
}

// ============================================================================
// EXECUTION FUNCTIONS (Require wallet client)
// ============================================================================

/**
 * Execute a liquidation transaction
 * @param account The account to liquidate
 * @param marketId The market ID
 * @param size The size to liquidate
 * @returns Transaction hash
 */
export async function executeLiquidation(
  account: `0x${string}`,
  marketId: `0x${string}`,
  size: bigint
): Promise<`0x${string}`> {
  if (!walletClient) {
    throw new Error('Wallet client not initialized - PRIVATE_KEY required');
  }

  // Simulate the transaction first
  const { request } = await publicClient.simulateContract({
    address: config.clearingHouseAddress,
    abi: clearingHouseAbi,
    functionName: 'liquidate',
    args: [account, marketId, size],
    account: walletClient.account,
  });

  // Execute the transaction
  const hash = await walletClient.writeContract(request);

  return hash;
}

/**
 * Poke funding rate update
 * @returns Transaction hash
 */
export async function executePokeFunding(): Promise<`0x${string}`> {
  if (!walletClient) {
    throw new Error('Wallet client not initialized - PRIVATE_KEY required');
  }

  // Simulate the transaction first
  const { request } = await publicClient.simulateContract({
    address: config.vammAddress,
    abi: vammAbi,
    functionName: 'pokeFunding',
    account: walletClient.account,
  });

  // Execute the transaction
  const hash = await walletClient.writeContract(request);

  return hash;
}

/**
 * Wait for transaction confirmation
 * @param hash Transaction hash
 * @returns Transaction receipt
 */
export async function waitForTransaction(hash: `0x${string}`) {
  return await publicClient.waitForTransactionReceipt({ hash });
}

/**
 * Get current gas price
 * @returns Gas price in gwei
 */
export async function getGasPrice(): Promise<number> {
  const gasPrice = await publicClient.getGasPrice();
  return Number(gasPrice) / 1e9; // Convert to gwei
}

/**
 * Estimate gas for liquidation
 * @param account The account to liquidate
 * @param marketId The market ID
 * @param size The size to liquidate
 * @returns Estimated gas units
 */
export async function estimateLiquidationGas(
  account: `0x${string}`,
  marketId: `0x${string}`,
  size: bigint
): Promise<bigint> {
  if (!walletClient) {
    throw new Error('Wallet client not initialized - PRIVATE_KEY required');
  }

  return await publicClient.estimateContractGas({
    address: config.clearingHouseAddress,
    abi: clearingHouseAbi,
    functionName: 'liquidate',
    args: [account, marketId, size],
    account: walletClient.account,
  });
}
