# ByteStrike Liquidation Bot

A Node.js/TypeScript bot that monitors the ByteStrike perpetual futures protocol for positions at risk of liquidation. Supports both **monitoring mode** (alerts only) and **execution mode** (automatic liquidations).

## Features

### Monitoring Features
- **Position Monitoring**: Tracks all open positions in the protocol via event indexing
- **Health Status Detection**: Categorizes positions into SAFE, WARNING, or LIQUIDATABLE
- **Email Alerts**: Sends notifications via SendGrid when positions enter warning/liquidation zones
- **Rate Limiting**: Prevents alert spam with 5-minute cooldown per account
- **Real-time Sync**: Automatically discovers new positions from blockchain events
- **Market Status**: Displays current mark price, oracle price, and funding premium

### Execution Features (NEW!)
- **Automatic Liquidations**: Execute liquidations when profitable
- **Profitability Checks**: Only liquidates when expected reward exceeds gas costs + minimum threshold
- **Gas Price Protection**: Skip transactions when gas prices are too high
- **Funding Rate Pokes**: Periodically update funding rates (configurable interval)
- **Dry Run Mode**: Simulate executions without sending transactions
- **Execution Statistics**: Track total liquidations, rewards, and gas costs
- **Transaction Simulation**: All transactions are simulated before execution to prevent failures

## Alert Zones

The bot monitors the margin health of each position:

- **SAFE** (Green): `Effective Margin >= Initial Margin Requirement (IMR)`
  - Position is healthy with sufficient collateral

- **WARNING** (Yellow): `MMR <= Effective Margin < IMR`
  - Position is below IMR but still above liquidation threshold
  - User should consider adding margin or reducing position

- **LIQUIDATABLE** (Red): `Effective Margin < Maintenance Margin (MMR)`
  - Position can be liquidated immediately
  - Urgent action required

## Setup

### 1. Install Dependencies

```bash
cd liquidation-bot
npm install
```

### 2. Configure Environment

Copy the example environment file and fill in your values:

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```env
# RPC Configuration
RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_ALCHEMY_KEY

# Execution Mode Configuration
PRIVATE_KEY=0xYourPrivateKeyHere  # REQUIRED for execution mode
EXECUTE_MODE=false  # Set to 'true' to enable liquidation execution
DRY_RUN=false       # Set to 'true' to simulate without sending txs

# Execution Parameters
MIN_LIQUIDATION_REWARD_USD=10  # Minimum profit to execute (USD)
MAX_GAS_PRICE_GWEI=50          # Skip if gas price exceeds this
FUNDING_POKE_INTERVAL_MS=3600000  # 1 hour

# SendGrid Configuration (optional for email alerts)
SENDGRID_API_KEY=your_sendgrid_api_key
SENDGRID_FROM_EMAIL=alerts@yourdomain.com
ALERT_RECIPIENT_EMAIL=user@example.com

# Bot Configuration
POLLING_INTERVAL_MS=30000  # Check every 30 seconds
```

### Important: Execution Mode Setup

If you want to execute liquidations (not just monitor), follow these additional steps:

#### 1. Generate a Private Key

```bash
# Using Foundry's cast tool
cast wallet new

# Or use any wallet tool to generate a new address
```

⚠️ **Security Warning**:
- Never use your main wallet's private key
- Create a dedicated liquidator wallet
- Only fund it with enough ETH for gas (testnet ETH on Sepolia)
- Never commit your `.env` file to git

#### 2. Whitelist Your Liquidator Address

Your liquidator address must be whitelisted in the ClearingHouse contract. Contact the protocol admin to whitelist your address:

```solidity
// Admin must call:
clearingHouse.setLiquidatorWhitelist(yourLiquidatorAddress, true);
```

Without whitelisting, liquidation transactions will fail with "Caller is not a whitelisted liquidator".

#### 3. Fund Your Liquidator Wallet

On Sepolia testnet:
- Get test ETH from [Sepolia faucet](https://sepoliafaucet.com/)
- You need ETH for gas fees (transactions cost ~0.001-0.01 ETH)
- Start with 0.1 ETH to be safe

#### 4. Enable Execution Mode

In your `.env`:
```env
EXECUTE_MODE=true
```

### 3. Get SendGrid API Key

1. Sign up at [SendGrid](https://sendgrid.com/)
2. Create an API key with "Mail Send" permissions
3. Verify your sender email domain
4. Add the API key to your `.env` file

### 4. Get Alchemy/Infura RPC URL

1. Sign up at [Alchemy](https://www.alchemy.com/) or [Infura](https://infura.io/)
2. Create a new app for Sepolia testnet
3. Copy the HTTPS endpoint to your `.env` file

## Usage

### Monitoring Mode (Default - Safe)

Monitor positions and send alerts without executing transactions:

```bash
# Development
npm run dev

# Production
npm run build
npm run start
```

### Execution Mode (Automatic Liquidations)

Execute liquidations automatically when profitable:

```bash
# 1. Set EXECUTE_MODE=true in .env
# 2. Ensure PRIVATE_KEY is set and whitelisted
# 3. Run the bot
npm run build
npm run start
```

The bot will display:
```
⚡ EXECUTION MODE ENABLED - Bot will execute liquidations
```

### Dry Run Mode (Testing)

Test execution logic without sending transactions:

```bash
# Set in .env:
# EXECUTE_MODE=true
# DRY_RUN=true

npm run dev
```

Output will show simulated liquidations with:
```
🔍 DRY RUN MODE - Skipping actual execution
```

### Other Commands

#### Test Email Configuration
```bash
npm run dev -- --test-email
```

#### Track Specific Account
```bash
npm run dev -- --track 0xYourAddress
```

#### Help
```bash
npm run dev -- --help
```

## How It Works

### Monitoring Mode

1. **Initialization**
   - Connects to Sepolia testnet via RPC
   - Validates configuration
   - Scans historical events (last 50k blocks) to find all open positions

2. **Monitoring Loop** (every 30 seconds by default)
   - Syncs new position events from blockchain
   - Calculates margin health for each tracked position
   - Sends alerts for positions in WARNING or LIQUIDATABLE zones
   - Logs status changes to console

3. **Margin Health Calculation**
   ```
   Notional Value = |Position Size| × Mark Price
   Unrealized PnL = (Mark Price - Entry Price) × Position Size  // for longs
   Effective Margin = Stored Margin + Unrealized PnL

   IMR = Notional Value × IMR_BPS / 10000  (10%)
   MMR = Notional Value × MMR_BPS / 10000  (2.5%)
   ```

4. **Alert Triggers**
   - Status changes (SAFE → WARNING, WARNING → LIQUIDATABLE)
   - New LIQUIDATABLE status (always alert)
   - Rate limited to prevent spam

### Execution Mode (Additional Features)

5. **Funding Rate Pokes** (every 1 hour by default)
   - Calls `vAMM.pokeFunding()` to update funding rates
   - Ensures accurate funding calculations for all traders
   - Skipped if gas price exceeds maximum

6. **Liquidation Execution** (when LIQUIDATABLE position found)
   ```
   Step 1: Calculate expected reward
     - Penalty = Notional × 2% (liquidationPenaltyBps)
     - Liquidator Reward = Penalty × 50%
     - Expected Reward (USD) = Reward in quote tokens

   Step 2: Estimate gas costs
     - Simulate transaction to estimate gas units
     - Gas Cost (USD) = Gas Units × Gas Price × ETH Price

   Step 3: Profitability check
     - Net Profit = Expected Reward - Gas Cost
     - Execute only if Net Profit > MIN_LIQUIDATION_REWARD_USD
     - Skip if gas price > MAX_GAS_PRICE_GWEI

   Step 4: Execute liquidation
     - Simulate transaction first (catch errors early)
     - Send transaction via wallet client
     - Wait for confirmation
     - Log results and update statistics
   ```

7. **Execution Statistics**
   - Tracks total liquidations attempted/successful/failed
   - Calculates cumulative rewards and gas costs
   - Displays net profit
   - Logs to console after each monitoring cycle

## Project Structure

```
liquidation-bot/
├── src/
│   ├── index.ts           # Main entry point and CLI
│   ├── config.ts          # Configuration management
│   ├── types.ts           # TypeScript type definitions
│   ├── abis.ts            # Contract ABIs (read + write functions)
│   ├── blockchain.ts      # Blockchain interaction (read + execute)
│   ├── tracker.ts         # Position tracking via events
│   ├── monitor.ts         # Main monitoring + execution logic
│   ├── executor.ts        # Liquidation execution with profitability checks
│   └── notifications.ts   # Email alerting via SendGrid
├── .env.example           # Environment template
├── package.json           # Dependencies
├── tsconfig.json          # TypeScript config
└── README.md              # This file
```

## Deployed Contract Addresses (Sepolia)

- **ClearingHouse**: `0x445Fa8890562Ec6220A60b3911C692DffaD49AcB`
- **vAMM (Active)**: `0x3f9b634b9f09e7F8e84348122c86d3C2324841b5`
- **Oracle**: `0x3cA2Da03e4b6dB8fe5a24c22Cf5EB2A34B59cbad`
- **Market ID (ETH-PERP-V2)**: `0x385badc...087a28`

## Configuration Parameters

### Execution Settings

| Parameter | Default | Description |
|-----------|---------|-------------|
| `EXECUTE_MODE` | `false` | Enable automatic liquidation execution |
| `DRY_RUN` | `false` | Simulate transactions without sending |
| `PRIVATE_KEY` | - | Private key for liquidator wallet (required for execution) |

### Profitability Controls

| Parameter | Default | Description |
|-----------|---------|-------------|
| `MIN_LIQUIDATION_REWARD_USD` | `10` | Minimum net profit to execute liquidation |
| `MAX_GAS_PRICE_GWEI` | `50` | Maximum gas price (skip if exceeded) |
| `FUNDING_POKE_INTERVAL_MS` | `3600000` | How often to poke funding (1 hour) |

### Bot Settings

| Parameter | Default | Description |
|-----------|---------|-------------|
| `POLLING_INTERVAL_MS` | `30000` | Monitoring cycle interval (30 seconds) |
| `WARNING_THRESHOLD_BUFFER` | `0.1` | Buffer for warning threshold |

## Future Enhancements

- [ ] Database persistence for position tracking (Redis/PostgreSQL)
- [ ] Discord/Telegram notification support
- [ ] Web dashboard for monitoring
- [ ] Multi-market support
- [x] ✅ **Liquidation execution** (COMPLETED!)
- [x] ✅ **Funding rate pokes** (COMPLETED!)
- [ ] Historical analytics and reporting
- [ ] WebSocket support for faster updates
- [ ] MEV protection and flashbots integration
- [ ] Multi-signature wallet support for added security

## Important Notes

### For Monitoring Mode

1. **No Position Enumeration**: The smart contracts don't provide a way to list all positions. The bot tracks positions by monitoring `PositionOpened` and `PositionClosed` events.

2. **Rate Limiting**: Email alerts have a 5-minute cooldown per account to prevent spam during volatile markets.

3. **No Gas Costs**: Monitoring mode doesn't execute transactions or consume gas.

### For Execution Mode

1. **Whitelist Requirement**: Your liquidator address MUST be whitelisted by the protocol admin. Without whitelisting, all liquidation transactions will fail.

2. **Profitability First**: The bot will only execute liquidations if the expected reward exceeds gas costs plus the minimum threshold. Unprofitable liquidations are skipped.

3. **Gas Price Protection**: Transactions are skipped when gas prices are too high to prevent unprofitable executions during network congestion.

4. **Front-Running Risk**: Other liquidators may execute liquidations before you. The bot handles this gracefully by simulating transactions first.

5. **Private Key Security**:
   - Never use your main wallet
   - Never commit `.env` to git
   - Use a dedicated liquidator wallet with only gas funds
   - Consider using a hardware wallet in production

6. **Testnet Only**: Currently configured for Sepolia testnet. Modify contract addresses and thoroughly test before mainnet deployment.

## License

MIT
