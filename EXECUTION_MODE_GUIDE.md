# Execution Mode — Setup Guide

How to take the bot from read-only monitoring to actually liquidating positions on
the live Sepolia deployment.

Read the [README](./README.md) first for how the bot works. This guide is only the
operational path to executing.

---

## Before you start

Three things gate execution. Any one of them missing means zero liquidations:

1. **An archive-capable RPC.** The bot backfills `TradeExecuted` logs from the deploy
   block. Public endpoints (publicnode, etc.) reject historical `eth_getLogs` with
   *"Archive requests require a personal token"*. You need Alchemy or Infura.
2. **A whitelisted liquidator address.** `liquidate` is behind
   `onlyWhitelistedLiquidator`. Without it, every attempt reverts.
3. **A fresh oracle on the market you want to liquidate in.** Stale oracles make
   `isLiquidatable` itself revert — see [Stale oracles](#stale-oracles).

---

## Step 1 — Generate a liquidator wallet

The bot has **no address of its own**. Its identity is derived from the `PRIVATE_KEY`
you give it, so until you set one there is nothing to whitelist.

```bash
cast wallet new
```

Use a **dedicated** wallet. Fund it with gas only — never reuse a wallet that holds
anything you care about. The key goes in `.env` (already gitignored):

```env
PRIVATE_KEY=0xabc...
```

## Step 2 — Read the bot's address

```bash
npm run dev -- --address
```

```
Liquidator address: 0x...
Balance:            0.0 ETH
Whitelisted:        NO

An admin must run, on the ClearingHouse (0xDf4DDD4019097B335dD507f916984A1A53E40a0d):
  setWhitelistedLiquidator(0x..., true)
```

That address is what gets whitelisted. Re-run this command any time to confirm the
whitelist landed.

## Step 3 — Whitelist it

A protocol admin must call, on the **ClearingHouse proxy**
`0xDf4DDD4019097B335dD507f916984A1A53E40a0d`:

```solidity
clearingHouse.setWhitelistedLiquidator(<botAddress>, true);
```

Or with `cast`, from the admin key:

```bash
cast send 0xDf4DDD4019097B335dD507f916984A1A53E40a0d \
  "setWhitelistedLiquidator(address,bool)" <botAddress> true \
  --rpc-url $RPC_URL --private-key $ADMIN_KEY
```

Note the name: it is `setWhitelistedLiquidator`, **not** `setLiquidatorWhitelist`.

The bot verifies this at startup and refuses to run in execute mode without it, rather
than discovering it one revert at a time.

## Step 4 — Fund it with gas

Get Sepolia ETH from a faucet. ~0.1 ETH is plenty. Gas is the only thing this wallet
spends — rewards are paid in the quote token, not ETH.

## Step 5 — Dry run

Prove the whole path before spending anything:

```env
EXECUTE_MODE=true
DRY_RUN=true
```

```bash
npm run dev
```

Dry run does everything except send: it re-reads the position, re-checks
liquidatability, **simulates the transaction**, and prices profitability. It reports
skips honestly and does not count simulated liquidations as successes. If a
liquidation would revert, you find out here.

## Step 6 — Go live

```env
EXECUTE_MODE=true
DRY_RUN=false
```

```bash
npm run build && npm start
```

You should see:

```
⚡ EXECUTION MODE ENABLED - Bot will execute liquidations
Liquidator: 0x...
Whitelisted: true
```

---

## What happens on each liquidation

1. Re-read the position from chain. The tracker's size is a cache, and the contract
   requires `0 < size <= currentSize` — a stale size reverts as `InvalidSize`.
2. Re-check `isLiquidatable` and `isActive`. Another liquidator may have front-run
   you, or the price may have recovered.
3. Check gas price against `MAX_GAS_PRICE_GWEI`.
4. **Simulate.** This catches reverts early and produces the gas estimate.
5. Price it. Execute only if `reward - gasCost > MIN_LIQUIDATION_REWARD_USD`.
6. Send, wait for the receipt, record the result.

---

## Profitability: read this before setting a threshold

The reward mirrors the contract exactly, with every input read from chain:

```
notional = size * oraclePrice / 1e18        (pre-trade risk price, rounded up)
penalty  = min(notional * liquidationPenaltyBps / 10000, penaltyCap)
reward   = feeRouter set ? penalty / 2 : penalty
```

On the **current Sepolia markets**, verified on-chain:

| Parameter | Value |
| --- | --- |
| `liquidationPenaltyBps` | 250 (2.5%) |
| `penaltyCap` | `1000e18` |
| FeeRouter | set on every market → 50/50 split |

**The cap binds.** Your reward is capped at roughly **500 quote units per liquidation,
no matter how large the position.** A percentage-of-notional mental model overstates
what you earn on big positions. Set `MIN_LIQUIDATION_REWARD_USD` with that ceiling in
mind — a threshold above ~500 will never fire.

### Gas pricing

These are GPU compute perps. No market's mark price tells you anything about ETH, so
gas cannot be costed from market data. Set `ETH_PRICE_USD` yourself:

```env
ETH_PRICE_USD=3000
```

It is used **only** to convert gas into USD for the profitability comparison.

---

## Key settings

| Variable | Default | Notes |
| --- | --- | --- |
| `EXECUTE_MODE` | `false` | `true` to liquidate |
| `DRY_RUN` | `false` | Simulate and price, never send |
| `MIN_LIQUIDATION_REWARD_USD` | `10` | Net profit floor; remember the ~500 ceiling |
| `MAX_GAS_PRICE_GWEI` | `50` | Skip above this |
| `ETH_PRICE_USD` | `3000` | Gas costing only |
| `AMOUNT_LIMIT_MODE` | `zero` | `zero` = no slippage guard, `mark` = derive from mark price |
| `SLIPPAGE_BPS` | `50` | Only used when mode is `mark` |
| `MARKET_IDS` | *(all)* | Comma-separated allowlist |
| `START_BLOCK` | `10797215` | Deploy block; raise to speed up bootstrap |
| `FUNDING_POKE_INTERVAL_MS` | `3600000` | Per-market `pokeFunding` cadence |

### amountLimit

`liquidate` takes an `amountLimit` guarding the vAMM leg against slippage: a minimum
quote-out when closing a long, a maximum quote-in when closing a short. `zero`
disables the guard, which is the sane default — the position is already underwater and
you want the liquidation to land. Use `mark` if you want protection against a thin or
manipulated vAMM, and raise `SLIPPAGE_BPS` if you see the transaction reverting.

---

## Stale oracles

The CuOracle adapters revert with `CuOracleAdapter_PriceStale()` when a feed hasn't
been refreshed inside its staleness window. On Sepolia this is common — at time of
writing `B200-PERP-V2` was stale while `H200-PERP-V2`, `AWS-H100-PERP` and `T4-PERP`
were fresh.

**Nothing can be liquidated in a market with a stale oracle**, because `isLiquidatable`
reverts too. The bot detects this, logs one warning per market per cycle, skips that
market, and keeps going.

To fix, refresh the feed using the price scripts in `bytestrikecontracts/script/`
(e.g. `SetCuOracleETHPrice.s.sol`, `UpdateH200ProviderPrices.s.sol`).

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Refuses to start: *"not a whitelisted liquidator"* | Step 3 hasn't landed. Confirm with `--address`. |
| *"Archive requests require a personal token"* | Public RPC. Use Alchemy/Infura, or raise `START_BLOCK`. |
| *"stale oracle price - skipping"* | Feed needs refreshing. Not a bot bug. |
| `NotLiquidatable` on simulate | Front-run, or the price recovered. A clean skip. |
| `InvalidSize` | Position changed under you. The bot re-reads size, so this should be rare. |
| `RemainingBelowMinLiquidateFull` | A partial liquidation would leave dust below `minPositionSize`. |
| Everything logged as "not profitable" | Check `MIN_LIQUIDATION_REWARD_USD` against the ~500 reward ceiling. |
| Zero positions found | Backfill never completed — almost always the RPC. |

---

## Security

- Dedicated wallet, gas only. Never a main key.
- `.env` is gitignored. Keep it that way.
- Start in `DRY_RUN`. Only disable it once you've seen a simulation pass.
- This is Sepolia. Re-audit the profitability model and the `penaltyCap` before
  pointing this at mainnet value.
