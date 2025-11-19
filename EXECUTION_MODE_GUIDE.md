# Liquidation Bot Execution Mode - Quick Start Guide

## Overview

Your liquidation bot now supports **automatic liquidation execution** with built-in profitability checks, gas price protection, and periodic funding rate updates.

## What's New

### ✅ Features Added

1. **Automatic Liquidations**
   - Execute liquidations when positions become underwater
   - Profitability checks before execution
   - Gas price protection
   - Transaction simulation before sending

2. **Funding Rate Pokes**
   - Periodically calls `vAMM.pokeFunding()` (default: every 1 hour)
   - Ensures accurate funding calculations for all traders
   - Gas-optimized (only when needed)

3. **Execution Statistics**
   - Track total liquidations executed
   - Monitor total rewards vs gas costs
   - Calculate net profit in real-time

4. **Safety Features**
   - Dry run mode for testing
   - Minimum profitability threshold
   - Maximum gas price limit
   - Transaction simulation before execution
   - Graceful error handling

## Quick Setup (5 Minutes)

### Step 1: Generate Liquidator Wallet

```bash
# Using Foundry's cast tool
cast wallet new

# Output:
# Successfully created new keypair.
# Address:     0x1234567890123456789012345678901234567890
# Private key: 0xabcdef...
```

**⚠️ IMPORTANT**: Save this private key securely! Never share it or commit it to git.

### Step 2: Get Test ETH (Sepolia)

Visit https://sepoliafaucet.com/ and request test ETH for your new address.

You'll need about **0.1 ETH** for gas fees.

### Step 3: Whitelist Your Address

Contact the ByteStrike protocol admin to whitelist your liquidator address:

```solidity
// Admin needs to call:
clearingHouse.setLiquidatorWhitelist(0x1234567890123456789012345678901234567890, true);
```

**Verification**: You can check if you're whitelisted by calling:
```bash
cast call 0x445Fa8890562Ec6220A60b3911C692DffaD49AcB \
  "WhitelistedLiquidators(address)(bool)" \
  0xYourAddress \
  --rpc-url $SEPOLIA_RPC_URL
```

### Step 4: Configure .env

```bash
cd liquidation-bot
cp .env.example .env
```

Edit `.env`:

```env
# ============ REQUIRED FOR EXECUTION ============
RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_ALCHEMY_KEY
PRIVATE_KEY=0xYourPrivateKeyFromStep1
EXECUTE_MODE=true

# ============ OPTIONAL TUNING ============
# Start with dry run to test
DRY_RUN=false

# Profitability settings
MIN_LIQUIDATION_REWARD_USD=10  # Skip if profit < $10
MAX_GAS_PRICE_GWEI=50          # Skip if gas > 50 gwei

# Intervals
POLLING_INTERVAL_MS=30000           # Check every 30 seconds
FUNDING_POKE_INTERVAL_MS=3600000    # Poke funding every 1 hour
```

### Step 5: Test with Dry Run First

Before executing real transactions, test with dry run mode:

```bash
# Set in .env:
# EXECUTE_MODE=true
# DRY_RUN=true

npm run build
npm run start
```

Look for:
```
⚡ EXECUTION MODE ENABLED - Bot will execute liquidations
🔍 DRY RUN MODE - Transactions will be simulated but not sent
```

The bot will show what it would do without spending gas.

### Step 6: Go Live!

Once you're confident:

```bash
# Set in .env:
# DRY_RUN=false

npm run build
npm run start
```

Look for:
```
⚡ EXECUTION MODE ENABLED - Bot will execute liquidations
```

## How It Works

### Monitoring Loop (Every 30 seconds)

1. **Sync Events**: Discover new positions from blockchain events
2. **Check Funding**: Poke funding if 1 hour has elapsed
3. **Calculate Health**: Check margin health for all positions
4. **Find Liquidations**: Identify LIQUIDATABLE positions
5. **Profitability Check**:
   ```
   Expected Reward = Position Notional × 2% × 50%
   Gas Cost = Estimated Gas × Gas Price × ETH Price
   Net Profit = Expected Reward - Gas Cost

   Execute if: Net Profit > MIN_LIQUIDATION_REWARD_USD
   ```
6. **Execute**: Send liquidation transaction
7. **Wait & Log**: Confirm transaction and update statistics

### Profitability Example

```
Position: 10 ETH short
Mark Price: $3.75
Notional: 10 × $3.75 = $37.50

Penalty: $37.50 × 2% = $0.75
Liquidator Reward: $0.75 × 50% = $0.375

Gas: 300,000 units × 20 gwei = 0.006 ETH
Gas Cost: 0.006 × $3.75 = $0.0225

Net Profit: $0.375 - $0.0225 = $0.35

✅ Execute (profit > $0.10 minimum)
```

## Configuration Parameters

### Essential Settings

| Parameter | Recommended | Description |
|-----------|-------------|-------------|
| `EXECUTE_MODE` | `true` | Enable execution |
| `DRY_RUN` | `false` | Start with `true` to test |
| `PRIVATE_KEY` | Your key | From Step 1 |
| `RPC_URL` | Alchemy/Infura | Your RPC endpoint |

### Profitability Tuning

| Parameter | Default | Adjust If... |
|-----------|---------|--------------|
| `MIN_LIQUIDATION_REWARD_USD` | `10` | Increase on mainnet (higher gas costs) |
| `MAX_GAS_PRICE_GWEI` | `50` | Lower during high network usage |
| `FUNDING_POKE_INTERVAL_MS` | `3600000` | Increase to save gas (less frequent) |

### Performance Tuning

| Parameter | Default | Adjust If... |
|-----------|---------|--------------|
| `POLLING_INTERVAL_MS` | `30000` | Decrease for faster detection (more RPC calls) |

## Monitoring Your Bot

### Console Output

```
[2025-01-XX] Monitoring 5 positions...
Status: 3 safe, 1 warning, 1 liquidatable

Mark Price: $3.75
Oracle Price: $3.75

🚨 LIQUIDATABLE position found: 0x1234567890...

💰 Profitability check:
   Expected reward: $15.50
   Estimated gas cost: $0.25
   Net profit: $15.25
   Minimum required: $10
   Profitable: ✅

⚡ Executing liquidation transaction...
📝 Transaction sent: 0xabcd...
   View on Etherscan: https://sepolia.etherscan.io/tx/0xabcd...
⏳ Waiting for confirmation...
✅ Liquidation successful!
   Block: 12345678
   Gas used: 285432
   Estimated reward: $15.50

📊 Execution Statistics:
   Total liquidations attempted: 1
   Successful: 1
   Failed: 0
   Total rewards: $15.50
   Total gas costs: $0.25
   Net profit: $15.25
```

### Transaction Tracking

All liquidations are logged on Etherscan:
- Sepolia: https://sepolia.etherscan.io/address/YOUR_LIQUIDATOR_ADDRESS

## Common Issues

### ❌ "Caller is not a whitelisted liquidator"

**Problem**: Your address isn't whitelisted in the ClearingHouse contract.

**Solution**: Contact the protocol admin to whitelist your address (see Step 3).

### ❌ "Not liquidatable"

**Problem**: Position was liquidated by another bot (front-run).

**Solution**: This is normal in competitive liquidation environments. The bot will skip and move on.

### ❌ "Gas price too high"

**Problem**: Current gas price exceeds `MAX_GAS_PRICE_GWEI`.

**Solution**:
- Wait for gas to decrease (bot will retry on next cycle)
- Or increase `MAX_GAS_PRICE_GWEI` if acceptable

### ❌ "Liquidation not profitable - skipping"

**Problem**: Expected profit is less than `MIN_LIQUIDATION_REWARD_USD`.

**Solution**:
- Lower `MIN_LIQUIDATION_REWARD_USD` if you want to accept smaller profits
- Or wait for larger positions to become liquidatable

## Safety Checklist

Before going live:

- [ ] Tested with `DRY_RUN=true` first
- [ ] Liquidator address is whitelisted
- [ ] Wallet funded with test ETH (0.1 ETH minimum)
- [ ] Private key is NOT in git (`.env` in `.gitignore`)
- [ ] Using a dedicated liquidator wallet (not your main wallet)
- [ ] RPC URL is working (test with `npm run dev -- --help`)
- [ ] Email alerts configured (optional)
- [ ] Understand profitability parameters

## Advanced Usage

### Multiple Bots (Competition)

Run multiple bots with different strategies:

```bash
# Bot 1: Aggressive (lower profit threshold)
MIN_LIQUIDATION_REWARD_USD=5
MAX_GAS_PRICE_GWEI=100

# Bot 2: Conservative (higher profit threshold)
MIN_LIQUIDATION_REWARD_USD=20
MAX_GAS_PRICE_GWEI=30
```

### Custom Funding Poke Schedule

```bash
# Poke every 30 minutes
FUNDING_POKE_INTERVAL_MS=1800000

# Poke every 2 hours
FUNDING_POKE_INTERVAL_MS=7200000
```

## Support & Troubleshooting

1. Check console logs for detailed error messages
2. Review transaction on Etherscan for failure reasons
3. Verify wallet has sufficient ETH balance
4. Confirm whitelist status
5. Test with `DRY_RUN=true` to debug logic

## Next Steps

Once running successfully on Sepolia:

1. Monitor performance for 24 hours
2. Tune profitability parameters based on actual results
3. Set up monitoring dashboards (optional)
4. Consider database persistence for production
5. Plan for mainnet deployment (higher gas costs, real money!)

---

**Remember**: Start small, test thoroughly, and never risk more than you can afford to lose!
