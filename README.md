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

**Position discovery.** The ClearingHouse has no way to enumerate positions. The
shared `canonical-indexer` service already writes every ClearingHouse PnL event to
Supabase (`canonical_pnl_events`), so the bot reads positions from there, read-only:

- At startup it loads, for each `(user_address, market_id)`, the latest row with a
  `new_size` (ordered by `block_number, transaction_index, primary_log_index`) up to
  the indexer checkpoint, and keeps it if `new_size != 0`. A `close` row without
  `new_size` means flat. `new_size` is the decimal string `formatUnits(newSize, 18)`
  and is parsed back to the exact integer.
- Each cycle it reads only rows with `cursor < block_number <= checkpoint`.
- **Fallback:** if Supabase is not configured or errors, or the checkpoint in
  `canonical_indexer_checkpoints` is more than `INDEXER_MAX_LAG_BLOCKS` (40) behind the
  head, the bot reads `TradeExecuted` logs itself, incrementally from its last synced
  block. Without Supabase at startup it replays from `START_BLOCK` as before.

`TradeExecuted.newSize` (which is also what the indexer stores) covers opens,
resizes, closes *and* liquidations in one signal: `0` means flat.

**Monitoring.** Each 30s cycle is **one** `Multicall3.aggregate3` `eth_call`:
`isLiquidatable` + `getMarginRatio` per position, `oracle.getPrice` +
`vamm.getReserves` per market, and `Multicall3.getBlockNumber` for the head. There is
no `getPosition` (size comes from the source). `getMarket`, `marketRiskParams`,
`liquidationPriceBandBps` and `vAMM.feeBps` are cached for 10 minutes.

**Health classification.** `isLiquidatable()` on-chain is the sole authority for
`LIQUIDATABLE`. It folds in pending funding and real-time collateral valuation
(quote-token depeg), which cannot be faithfully reproduced off-chain. The bot's own
IMR comparison is used only to raise an early `WARNING`, and is deliberately
approximate.

**Liquidation.** `liquidate(account, marketId, size, amountLimit)`:

1. Size it inside the price band. The ClearingHouse reverts
   `LiquidationPriceOutOfBand` if a closing long sells below `index * (1 - band)` or a
   closing short buys above `index * (1 + band)` (`liquidationPriceBandBps`, default
   500). Using the vAMM reserves and fee from this cycle's multicall, the bot
   binary-searches the largest size whose constant-product fill stays inside the band
   (exact integer mirror of `vAMM.sellBase`/`buyBase`). If that leaves less than
   `minPositionSize`, it closes fully only if the full close is in band, else it takes
   `size - minPositionSize`. `amountLimit` is the band-edge quote amount (min quote out
   for a long, max quote in for a short), so a pool that moved reverts in the vAMM
   instead of filling outside the band. If the ClearingHouse has no
   `liquidationPriceBandBps` (pre-upgrade), it closes in full with the legacy
   `AMOUNT_LIMIT_MODE`.
2. One `eth_estimateGas` — the only pre-send execution. It simulates (custom errors
   such as `LiquidationPriceOutOfBand`, `NotLiquidatable`, `MustLiquidateMore` and
   stale oracle are decoded) and its result (+20%) is passed as `gas`.
3. Price it: `reward - gasCost > MIN_LIQUIDATION_REWARD_USD`.
4. Send with explicit `maxFeePerGas` (skipped if the estimate is above
   `MAX_GAS_PRICE_GWEI`), wait for the receipt.

Any non-success (revert, out of band, unprofitable, dry run) puts that
`(account, market)` into backoff: it is not retried until the index or mark price
moves more than 0.5% or 10 cycles pass.

**Funding pokes** are off by default (`FUNDING_POKE_ENABLED=false`): funding accrues
on every trade and liquidation. When enabled, only markets with open interest and no
trade for `FUNDING_POKE_STALE_SEC` (24h) are poked, and an attempt is recorded even if
it fails.

**RPC accounting.** Every request goes through a counting transport; a `RPC_STATS`
line (calls per method, per-day projection) is logged every 10 minutes and the totals
are on the health endpoint.

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

### Supabase (recommended)

Set `SUPABASE_URL` and `SUPABASE_KEY` (anon key is enough - the tables are publicly
readable; the service-role key also works). The bot never writes to the database.
`INDEXER_NAME` and `CHAIN_ID` must match the canonical-indexer's.

### Without Supabase, an archive RPC is required

The fallback replays `TradeExecuted` from the deployment block (10,797,215). Public
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
npm test                                 # unit tests (node:test)
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

**Front-running.** Other liquidators compete. The bot simulates (estimateGas)
immediately before sending, so a lost race is a clean skip rather than a failed
transaction.

**Persistence.** The position index is in-memory and rebuilt from Supabase on restart
(a few paged reads, no RPC). Only the getLogs fallback replays from `START_BLOCK`.

## Layout

```
src/
├── index.ts          # entry point, CLI, startup preflight (whitelist check)
├── config.ts         # env + live Sepolia defaults
├── abis.ts           # ABIs, matching bytestrikecontracts
├── blockchain.ts     # clients, cycle multicall, market cache, writes, RPC retry
├── tracker.ts        # position index: Supabase canonical_pnl_events, getLogs fallback
├── supabaseRows.ts   # new_size parsing + latest-row reconstruction (pure)
├── bandMath.ts       # price-band liquidation sizing on x*y=k (pure)
├── rpcStats.ts       # counting transport + RPC_STATS log
├── monitor.ts        # polling loop, health, funding pokes
├── executor.ts       # sizing, profitability, liquidation, backoff
├── notifications.ts  # SendGrid alerts
└── types.ts
test/                 # node:test unit tests
```

## License

MIT
