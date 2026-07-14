// ABIs for the ByteStrike contracts deployed on Sepolia.
// Source of truth: bytestrikecontracts/src/{ClearingHouse,VAMM}.sol and src/Interfaces/.
import { parseAbi, parseAbiItem } from 'viem';

export const clearingHouseAbi = parseAbi([
  'event TradeExecuted(address indexed user, bytes32 indexed marketId, int256 baseDelta, int256 quoteDelta, uint256 executionPrice, int256 newSize, uint256 newMargin, int256 realizedPnL, uint256 fee)',
  'function whitelistedLiquidators(address user) view returns (bool)',
  'function getPosition(address account, bytes32 marketId) view returns ((int256 size,uint256 margin,uint256 entryPriceX18,uint256 lastFundingPayIndex,uint256 lastFundingReceiveIndex,int256 realizedPnL))',
  'function isLiquidatable(address account, bytes32 marketId) view returns (bool)',
  'function liquidate(address account, bytes32 marketId, uint128 size, uint256 amountLimit)',
  'function marketRiskParams(bytes32 marketId) view returns (uint256 imrBps,uint256 mmrBps,uint256 liquidationPenaltyBps,uint256 penaltyCap,uint256 maxPositionSize,uint256 minPositionSize)',
]);

// Position discovery runs off TradeExecuted: it carries the post-trade newSize,
// so open/close/resize/liquidate all collapse into a single signal.
export const tradeExecutedEvent = parseAbiItem(
  'event TradeExecuted(address indexed user, bytes32 indexed marketId, int256 baseDelta, int256 quoteDelta, uint256 executionPrice, int256 newSize, uint256 newMargin, int256 realizedPnL, uint256 fee)'
);

export const marketRegistryAbi = parseAbi([
  'function getMarket(bytes32 marketId) view returns ((address vamm,uint16 feeBps,bool paused,address oracle,address feeRouter,address insuranceFund,address baseAsset,address quoteToken,uint256 baseUnit))',
  'function isActive(bytes32 marketId) view returns (bool)',
]);

export const oracleAbi = parseAbi([
  'function getPrice() view returns (uint256)',
]);

export const vammAbi = parseAbi([
  'function getMarkPrice() view returns (uint256)',
  'function pokeFunding() returns (uint256 longPay, uint256 longReceive, uint256 shortPay, uint256 shortReceive)',
]);
