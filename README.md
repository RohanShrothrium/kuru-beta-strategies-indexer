# Kuru Share Price Indexer

Envio indexer that tracks share prices, TVL, and user positions for every
[QuoteOnlyVault](../src/QuoteOnlyVault.sol) clone created by the
[VaultFactory](../src/VaultFactory.sol).

## What gets indexed

| Source | Event | Action |
|--------|-------|--------|
| VaultFactory | `VaultCreated(user, vault)` | Register new vault clone dynamically |
| QuoteOnlyVault | `Deposit` | Snapshot `totalAssets / totalSupply` → SharePricePoint |
| QuoteOnlyVault | `Withdraw` | Snapshot share price; update user position |
| QuoteOnlyVault | `Rebalance` | Snapshot share price (NAV changes on relever) |
| QuoteOnlyVault | `Rebalanced` | Snapshot share price (external rebalancer) |
| Block handler (every 100 blocks) | — | Periodic snapshot for time-series continuity |

## Entities

| Entity | Purpose |
|--------|---------|
| `Vault` | One record per clone; stores owner, factory, and latest snapshot values |
| `SharePricePoint` | Time-series rows: `{ timestamp, sharePriceE18, tvl, source }` |
| `UserPosition` | Per-user deposit/withdraw totals and current share balance |
| `VaultRegistry` | Factory-level registry used by the block handler to iterate all vaults |

`sharePriceE18` = `totalAssets * 1e18 / totalSupply` (WAD precision).
Divide by `1e18` and format with quote decimals (6 for USDC) in the frontend.

## Deployments tracked

| Market | VaultFactory |
|--------|-------------|
| MON/USDC | `0xCcb57703b65A8643401b11Cb40878F8cE0d622A3` |
| MON/AUSD | `0x79B99A1e9fF8F16a198Dac4b42Fd164680487062` |

Network: Monad mainnet (chain ID 143).

## Quick start

```bash
# 1. Install dependencies
cd indexer
npm install

# 2. Set environment variables
cp .env.example .env
# Edit .env — set MONAD_RPC_URL

# 3. Generate TypeScript bindings from schema + config
npx envio codegen

# 4. Start the indexer in dev mode (re-syncs from scratch)
npx envio dev
```

## 30-day APY calculation

Query `SharePricePoint` for a vault, sorted by `blockNumber` ascending.
Find the earliest point ≥ 30 days ago and the most recent point:

```
APY = ((latestPrice / price30dAgo) ^ (365 / 30) - 1) * 100
```

This calculation belongs in the API/frontend layer — the indexer stores the
raw price series; interpretation is left to the consumer.

## Adding new vault factories

Add the new factory address to:
1. `config.yaml` → `networks[0].contracts[0].address` array
2. `src/BlockHandler.ts` → `FACTORY_ADDRESSES` array

Then re-run `envio dev` to re-index from the factory's deployment block.
