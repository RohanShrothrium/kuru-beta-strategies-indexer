/**
 * BlockHandler.ts
 *
 * Periodic snapshot handler — fires every 100 blocks (configured in config.yaml).
 *
 * Purpose: even when no user events occur (e.g. Aave interest silently
 * increasing the vault NAV), we want at least one data point per ~100 blocks
 * so the time-series chart doesn't have large gaps.
 *
 * Strategy:
 *   1. Read the VaultRegistry entity for each known factory.
 *   2. Parse the JSON-encoded vault address list.
 *   3. eth_call totalAssets() + totalSupply() on every active vault.
 *   4. Write SharePricePoint with source = "Block".
 *
 * Performance note: eth_calls are batched via Promise.all, so the wall-clock
 * time is dominated by the slowest single vault, not the total count.
 */

import { onBlock } from "../generated/index.js";
import { snapshotVault } from "./utils";

// Factory addresses (must match config.yaml).
const FACTORY_ADDRESSES = [
  "0xccb57703b65a8643401b11cb40878f8ce0d622a3", // MONUSDC
  "0x79b99a1e9ff8f16a198dac4b42fd164680487062", // MONAUSD
];

// Register block handler: fires every 100 blocks for periodic snapshots.
onBlock(
  {
    name: "PeriodicSnapshot",
    chain: 143, // Monad mainnet
    interval: 100, // Run every 100 blocks
  },
  async (args) => {
    const blockNumber = BigInt(args.block.number);
    const context = args.context;
    
    // Note: blockEvent only provides block.number, not timestamp.
    // We estimate timestamp assuming ~1 second per block (adjust for your chain).
    // For accurate timestamps, we'd need to make an RPC call to eth_getBlockByNumber.
    const MONAD_GENESIS_TIMESTAMP = 1770000000; // Approximate Monad genesis time
    const BLOCK_TIME_SECONDS = 1; // Monad block time
    const timestamp = BigInt(MONAD_GENESIS_TIMESTAMP + Number(blockNumber) * BLOCK_TIME_SECONDS);

    // Collect all vault addresses across both factories.
    const vaultAddresses: string[] = [];
    for (const factoryAddr of FACTORY_ADDRESSES) {
      const registry = await context.VaultRegistry.get(factoryAddr);
      if (!registry) continue;

      const addrs: string[] = JSON.parse(registry.vaultAddresses);
      vaultAddresses.push(...addrs);
    }

    if (vaultAddresses.length === 0) return;

    // Snapshot all vaults concurrently.
    await Promise.all(
      vaultAddresses.map((addr) =>
        snapshotVault(addr, blockNumber, timestamp, "Block", context)
      )
    );
  }
);
