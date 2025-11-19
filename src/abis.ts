// Minimal ABIs for the contracts we need to interact with

export const clearingHouseAbi = [
  {
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'marketId', type: 'bytes32' }
    ],
    name: 'getPosition',
    outputs: [
      {
        components: [
          { name: 'size', type: 'int128' },
          { name: 'margin', type: 'uint128' },
          { name: 'entryPriceX18', type: 'uint256' },
          { name: 'lastFundingIndex', type: 'int256' },
          { name: 'realizedPnL', type: 'int256' }
        ],
        name: '',
        type: 'tuple'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'marketId', type: 'bytes32' }
    ],
    name: 'isLiquidatable',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'marketId', type: 'bytes32' }
    ],
    name: 'getMaintenanceMargin',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
  // Events for tracking positions
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'marketId', type: 'bytes32' },
      { indexed: true, name: 'account', type: 'address' },
      { indexed: false, name: 'sizeDelta', type: 'int128' },
      { indexed: false, name: 'newSize', type: 'int128' },
      { indexed: false, name: 'avgEntryPriceX18', type: 'uint256' },
      { indexed: false, name: 'newMarginReq', type: 'uint256' }
    ],
    name: 'PositionOpened',
    type: 'event'
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'marketId', type: 'bytes32' },
      { indexed: true, name: 'account', type: 'address' },
      { indexed: false, name: 'sizeClosed', type: 'uint128' },
      { indexed: false, name: 'remainingSize', type: 'int128' },
      { indexed: false, name: 'realizedPnL', type: 'int256' },
      { indexed: false, name: 'feesPaid', type: 'uint256' }
    ],
    name: 'PositionClosed',
    type: 'event'
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'marketId', type: 'bytes32' },
      { indexed: true, name: 'liquidator', type: 'address' },
      { indexed: true, name: 'account', type: 'address' },
      { indexed: false, name: 'size', type: 'uint128' },
      { indexed: false, name: 'notional', type: 'uint256' },
      { indexed: false, name: 'penalty', type: 'uint256' },
      { indexed: false, name: 'liquidatorReward', type: 'uint256' },
      { indexed: false, name: 'protocolFee', type: 'uint256' },
      { indexed: false, name: 'insurancePayout', type: 'uint256' }
    ],
    name: 'LiquidationExecuted',
    type: 'event'
  },
  // Write function - liquidate
  {
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'marketId', type: 'bytes32' },
      { name: 'size', type: 'uint128' }
    ],
    name: 'liquidate',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  }
] as const;

export const vammAbi = [
  {
    inputs: [],
    name: 'getMarkPrice',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [{ name: 'window', type: 'uint32' }],
    name: 'getTwap',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'cumulativeFundingPerUnitX18',
    outputs: [{ name: '', type: 'int256' }],
    stateMutability: 'view',
    type: 'function'
  },
  // Write function - pokeFunding
  {
    inputs: [],
    name: 'pokeFunding',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  }
] as const;

export const oracleAbi = [
  {
    inputs: [{ name: 'symbol', type: 'string' }],
    name: 'getPrice',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  }
] as const;
