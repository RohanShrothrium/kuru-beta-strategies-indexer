import { createPublicClient, http, parseAbi } from "viem";

// ---------------------------------------------------------------------------
// Viem public client — used for eth_call inside every handler.
// Envio replays the chain sequentially, so reads at a specific blockNumber
// reproduce the exact on-chain state at the moment the event was emitted.
//
// MONAD_RPC_URL must be set in the environment (or .env file).
// ---------------------------------------------------------------------------
export const publicClient = createPublicClient({
  transport: http(process.env.MONAD_RPC_URL ?? "https://rpc.monad.xyz"),
});

// Minimal ABI fragments needed for eth_call reads.
export const VAULT_READ_ABI = parseAbi([
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);

// ---------------------------------------------------------------------------
// snapshotVault
//
// Calls totalAssets() and totalSupply() on a vault at the given blockNumber,
// then writes a SharePricePoint and updates the parent Vault entity.
//
// sharePriceE18 = totalAssets * 1e18 / totalSupply
//   — stored as a raw uint so the API / frontend can format with any precision.
//   — When totalSupply == 0 (vault just deployed, never deposited) we store 0.
// ---------------------------------------------------------------------------
export async function snapshotVault(
  vaultAddress: string,
  blockNumber: bigint,
  timestamp: bigint,
  source: string,
  context: {
    Vault: { get(id: string): Promise<any>; set(v: any): void };
    SharePricePoint: { set(v: any): void };
  }
): Promise<void> {
  const addr = vaultAddress.toLowerCase() as `0x${string}`;

  let totalAssets = 0n;
  let totalSupply = 0n;

  try {
    [totalAssets, totalSupply] = await Promise.all([
      publicClient.readContract({
        address: addr,
        abi: VAULT_READ_ABI,
        functionName: "totalAssets",
        blockNumber,
      }) as Promise<bigint>,
      publicClient.readContract({
        address: addr,
        abi: VAULT_READ_ABI,
        functionName: "totalSupply",
        blockNumber,
      }) as Promise<bigint>,
    ]);
  } catch (err) {
    // A vault may revert before it has any position (e.g. at deployment block).
    // Skip gracefully — the next event or block tick will pick it up.
    console.warn(`[snapshotVault] eth_call failed for ${addr} @ ${blockNumber}: ${err}`);
    return;
  }

  const sharePriceE18 =
    totalSupply > 0n ? (totalAssets * 10n ** 18n) / totalSupply : 0n;

  // Write time-series point.
  const pointId = `${addr}-${blockNumber.toString()}-${source}`;
  context.SharePricePoint.set({
    id: pointId,
    vault_id: addr,
    timestamp,
    blockNumber,
    sharePriceE18,
    tvl: totalAssets,
    source,
  });

  // Update denormalised "latest" fields on the Vault entity.
  const vault = await context.Vault.get(addr);
  if (vault) {
    context.Vault.set({
      ...vault,
      latestSharePriceE18: sharePriceE18,
      latestTvl: totalAssets,
      latestSnapshotBlock: blockNumber,
    });
  }
}
