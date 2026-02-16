import { onBlock, type ChainId, indexer } from "generated";
import { createEffect, S } from "envio";
import {
  HypersyncClient,
  JoinMode,
  type FieldSelection,
  type TraceSelection,
  type TransactionSelection,
} from "@envio-dev/hypersync-client";

const initChain = async (chainId: ChainId) => {
  const client = new HypersyncClient({
    url: `https://${chainId}-traces.hypersync.xyz`,
    apiToken: process.env.ENVIO_API_TOKEN!,
  });

  // Batching state for getBlockTimestamp
  let pendingBatch: {
    blockNumbers: Set<number>;
    resolvers: Map<
      number,
      { resolve: (ts: number) => void; reject: (e: Error) => void }[]
    >;
    scheduled: boolean;
  } | null = null;

  const getBlockTimestamp = createEffect(
    {
      name: `getBlockTimestamp_${chainId}`,
      input: S.number,
      output: S.number,
      rateLimit: false,
    },
    async ({ input: blockNumber }) => {
      // Initialize batch if needed
      if (!pendingBatch) {
        pendingBatch = {
          blockNumbers: new Set(),
          resolvers: new Map(),
          scheduled: false,
        };
      }

      const batch = pendingBatch;
      batch.blockNumbers.add(blockNumber);

      // Create promise for this specific block number
      const promise = new Promise<number>((resolve, reject) => {
        const existing = batch.resolvers.get(blockNumber) || [];
        existing.push({ resolve, reject });
        batch.resolvers.set(blockNumber, existing);
      });

      // Schedule batch execution if not already scheduled
      if (!batch.scheduled) {
        batch.scheduled = true;
        queueMicrotask(async () => {
          const currentBatch = batch;
          pendingBatch = null; // Reset for next batch

          const blockNumbers = Array.from(currentBatch.blockNumbers);
          const minBlock = Math.min(...blockNumbers);
          const maxBlock = Math.max(...blockNumbers);

          try {
            // Build lookup map from results (with pagination)
            const timestampMap = new Map<number, number>();
            const toBlock = maxBlock + 1;
            let nextBlock = minBlock;

            while (nextBlock < toBlock) {
              const data = await client.get({
                fromBlock: nextBlock,
                toBlock,
                includeAllBlocks: true,
                fieldSelection: {
                  block: ["Number", "Timestamp"],
                },
              });

              for (const block of data.data.blocks) {
                if (
                  block.number !== undefined &&
                  block.timestamp !== undefined
                ) {
                  timestampMap.set(block.number, block.timestamp);
                }
              }

              nextBlock = data.nextBlock;
            }

            // Resolve all pending promises
            for (const [blockNum, resolverList] of currentBatch.resolvers) {
              const timestamp = timestampMap.get(blockNum);
              for (const { resolve, reject } of resolverList) {
                if (timestamp !== undefined) {
                  resolve(timestamp);
                } else {
                  reject(
                    new Error(`Timestamp not found for block ${blockNum}`)
                  );
                }
              }
            }
          } catch (error) {
            // Reject all pending promises on error
            for (const resolverList of currentBatch.resolvers.values()) {
              for (const { reject } of resolverList) {
                reject(
                  error instanceof Error ? error : new Error(String(error))
                );
              }
            }
          }
        });
      }

      return promise;
    }
  );

  const tracesFilter = [
    { include: { type: ["create"] } },
  ] as const satisfies TraceSelection[];
  // contractAddress as not null (any address)
  // OR if "to" is null, but we can't filter on it.
  const transactionsFilter = [
    {
      include: {},
    },
  ] as const satisfies TransactionSelection[];
  const fieldSelection = {
    transaction: ["BlockNumber", "ContractAddress"],
    trace: ["BlockNumber", "Address"],
  } as const satisfies FieldSelection;
  const getCreatedContracts = createEffect(
    {
      name: `getCreatedContracts_${chainId}`,
      input: S.tuple((ctx) => ({
        fromBlock: ctx.item(0, S.number),
        toBlock: ctx.item(1, S.number),
      })),
      output: S.array(
        S.schema({
          id: S.string,
          blockNumber: S.number,
        })
      ),
      rateLimit: false,
    },
    async ({ input }) => {
      const result = [];
      let nextBlock = input.fromBlock;
      while (nextBlock < input.toBlock) {
        const data = await client.get({
          fromBlock: nextBlock,
          toBlock: input.toBlock,
          traces: tracesFilter,
          transactions: transactionsFilter,
          fieldSelection: fieldSelection,
          joinMode: JoinMode.JoinNothing,
        });
        nextBlock = data.nextBlock;
        for (const trace of data.data.traces) {
          if (!trace.address) continue;
          if (!trace.blockNumber) continue;
          result.push({
            id: trace.address,
            blockNumber: trace.blockNumber,
          });
        }
        for (const transaction of data.data.transactions) {
          if (!transaction.contractAddress) continue;
          if (!transaction.blockNumber) continue;
          result.push({
            id: transaction.contractAddress,
            blockNumber: transaction.blockNumber,
          });
        }
      }
      return result;
    }
  );

  const interval = 200;
  const maxReorgThreshold = 200;
  const safeBlock = (await client.getHeight()) - maxReorgThreshold;

  const makeBlockHandler =
    (interval: number): Parameters<typeof onBlock>[1] =>
    async ({ context, block }) => {
      const contracts = await context.effect(getCreatedContracts, {
        fromBlock: block.number,
        toBlock: block.number + interval - 1,
      });
      await Promise.all(
        contracts.map(async (contract) => {
          const timestamp = await context.effect(
            getBlockTimestamp,
            contract.blockNumber
          );
          context.Contract.set({
            ...contract,
            blockTime: new Date(timestamp * 1000),
          });
        })
      );
    };

  onBlock(
    {
      name: `onBlock`,
      chain: chainId,
      interval,
      startBlock: 1, // Start block 0 doesn't show in the UI in a good way
      endBlock: safeBlock,
    },
    makeBlockHandler(interval)
  );
  onBlock(
    {
      name: `onBlock`,
      chain: chainId,
      interval: 1,
      // This + interval is needed, because the historical block handler
      // processes block forward to the current block
      startBlock: safeBlock + interval,
    },
    makeBlockHandler(1)
  );
};

for (const chainId of indexer.chainIds) {
  await initChain(chainId);
}