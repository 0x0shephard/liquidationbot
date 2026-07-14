# ByteStrike Liquidation Bot

A TypeScript bot that monitors the ByteStrike perpetuals protocol on **Sepolia** for
undercollateralized positions, alerts on them, and optionally liquidates them.

Targets the contracts in `bytestrikecontracts/` and the live Sepolia deployment
recorded in `deployments/sepolia-addresses.md`.

## Contracts

| Component | Address |
| --- | --- |
| ClearingHouse (proxy) | `0xDf4DDD4019097B335dD507f916984A1A53E40a0d` |
| MarketRegistry | `0x236b75D39203506ee3180Ef2E1c7460a188C43c6` |

Per-market **vAMM, oracle and FeeRouter addresses are resolved from the
MarketRegistry at runtime** — they are never hardcoded. The bot is multi-market by
default; set `MARKET_IDS` to restrict it.

## How it works

**Position discovery.** The ClearingHouse has no way to enumerate positions, so the
bot indexes `TradeExecuted` logs. That event carries the post-trade `newSize`, which
means opens, resizes, closes *and* liquidations all collapse into one signal:
`newSize == 0` means the account is flat. (`PositionOpened`/`PositionClosed` exist in
older versions of the protocol but not in the deployed one.)

**Health classification.** `isLiquidatable()` on-chain is the sole authority for
`LIQUIDATABLE`. It folds in pending funding and real-time collateral valuation
(quote-token depeg), which cannot be faithfully reproduced off-chain. The bot's own
IMR comparison is used only to raise an early `WARNING`, and is deliberately
approximate.

**Liquidation.** `liquidate(account, marketId, size, amountLimit)`:

1. Re-read the position from chain — the tracker's size is a cache, and the contract
   requires `0 < size <= currentSize`.
2. Re-check `isLiquidatable` and `isActive`.
3. Simulate. This catches reverts early *and* yields the gas estimate.
4. Price it: `reward - gasCost > MIN_LIQUIDATION_REWARD_USD`.
5. Send, wait for the receipt, record the result.

**Reward model** — mirrors the contract exactly, reading every input from chain:

```
notional = size * oraclePrice / 1e18          (pre-trade risk price, rounded up)
penalty  = min(notional * liquidationPenaltyBps / 10000, penaltyCap)
reward   = feeRouter set ? penalty / 2 : penalty
```

On the current Sepolia markets that is **250 bps, a `1000e18` cap, and a FeeRouter on
every market** — so the liquidator's reward is capped at roughly **500 quote units per
liquidation**, no matter how large the position. Assuming an uncapped percentage of
notional (as an earlier version did) overstates the reward on big positions.

## Setup

```bash
npm install
cp .env.example .env   # then edit
npm run build
npm start
```

### An archive RPC is required

Bootstrap replays `TradeExecuted` from the deployment block (10,797,215). Public
endpoints reject historical `eth_getLogs` with *"Archive requests require a personal
token"*. Use Alchemy/Infura, or raise `START_BLOCK` if you don't need older positions.

### Execution mode

Liquidating requires a whitelisted address — `liquidate` is behind
`onlyWhitelistedLiquidator`. An admin must call:

```solidity
clearingHouse.setWhitelistedLiquidator(yourAddress, true);
```

The bot verifies this at startup and **refuses to start** in execute mode without it,
rather than discovering it one revert at a time. Then:

```env
EXECUTE_MODE=true
PRIVATE_KEY=0x...
```

Use a dedicated wallet funded only with gas. Never reuse a main wallet key.

### Dry run

`DRY_RUN=true` runs every check, the simulation and the profitability calculation, but
never sends. It reports skips honestly — it does not count simulated liquidations as
successes.

## Modes

| | Reads | Alerts | Simulates | Sends txs |
| --- | --- | --- | --- | --- |
| Monitoring (default) | ✅ | ✅ | — | — |
| `DRY_RUN=true` | ✅ | ✅ | ✅ | — |
| `EXECUTE_MODE=true` | ✅ | ✅ | ✅ | ✅ |

## Commands

```bash
npm run dev                              # development
npm start                                # from build
npm run dev -- --help
npm run dev -- --test-email
npm run dev -- --track <account> <marketId>
```

## Operational notes

**Stale oracles.** The CuOracle adapters revert with `CuOracleAdapter_PriceStale()`
when a feed hasn't been refreshed inside its staleness window. On Sepolia this is
common — at time of writing `B200-PERP-V2` is stale while other markets are fresh. The
bot detects this, skips the affected market for that cycle with a single warning, and
keeps going. Nothing can be liquidated in a market whose oracle is stale, because
`isLiquidatable` reverts too. Refresh with the price scripts in `bytestrikecontracts/script/`.

**Gas pricing.** These are GPU compute perps. No market's mark price is a proxy for
ETH, so `ETH_PRICE_USD` must be supplied to convert gas into USD.

**Front-running.** Other liquidators compete. The bot re-checks liquidatability and
simulates immediately before sending, so a lost race is a clean skip rather than a
failed transaction.

**Persistence.** The position index is in-memory; a restart replays from `START_BLOCK`.
For production, persist `(account, marketId, lastSyncedBlock)`.

## Layout

```
src/
├── index.ts          # entry point, CLI, startup preflight (whitelist check)
├── config.ts         # env + live Sepolia defaults
├── abis.ts           # ABIs, matching bytestrikecontracts
├── blockchain.ts     # chain reads/writes, RPC retry, margin health
├── tracker.ts        # position index via TradeExecuted
├── monitor.ts        # polling loop
├── executor.ts       # profitability + liquidation execution
├── notifications.ts  # SendGrid alerts
└── types.ts
```

## License

MIT
