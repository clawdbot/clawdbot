// Memory Host SDK module implements batch runner behavior.
import { resolveSafeTimeoutDelayMs } from "../../../gateway-client/src/timeouts.js";
import { splitBatchRequestsByLimits } from "./batch-utils.js";
import { runMemoryHostTasksWithConcurrency } from "./internal.js";

// Shared runner for splitting and executing remote embedding batch groups.

/** Execution controls for provider embedding batch submissions and polling. */
export type EmbeddingBatchExecutionParams = {
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  concurrency: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
};

type EmbeddingBatchGroupRunArgs<TRequest> = {
  group: TRequest[];
  groupIndex: number;
  groups: number;
  byCustomId: Map<string, number[]>;
  pollIntervalMs: number;
  timeoutMs: number;
};

type EmbeddingBatchSplitArgs<TRequest> = {
  error: unknown;
  group: TRequest[];
  parts: TRequest[][];
  groupIndex: number;
  groups: number;
  depth: number;
};

/** Clamp polling to both configured poll interval and total timeout budget. */
function resolveEmbeddingBatchPollIntervalMs(params: {
  pollIntervalMs: number;
  timeoutMs: number;
}): number {
  const safePollIntervalMs = resolveSafeTimeoutDelayMs(params.pollIntervalMs);
  const safeTimeoutMs =
    typeof params.timeoutMs === "number" &&
    Number.isFinite(params.timeoutMs) &&
    params.timeoutMs > 0
      ? resolveSafeTimeoutDelayMs(params.timeoutMs)
      : safePollIntervalMs;
  return Math.min(safePollIntervalMs, safeTimeoutMs);
}

/** Run request groups with bounded concurrency and return embeddings by custom id. */
export async function runEmbeddingBatchGroups<TRequest>(params: {
  requests: TRequest[];
  maxRequests: number;
  maxJsonlBytes?: number;
  wait: EmbeddingBatchExecutionParams["wait"];
  pollIntervalMs: EmbeddingBatchExecutionParams["pollIntervalMs"];
  timeoutMs: EmbeddingBatchExecutionParams["timeoutMs"];
  concurrency: EmbeddingBatchExecutionParams["concurrency"];
  debugLabel: string;
  debug?: EmbeddingBatchExecutionParams["debug"];
  shouldSplitGroupOnError?: (error: unknown, group: TRequest[]) => boolean;
  onSplitGroup?: (args: EmbeddingBatchSplitArgs<TRequest>) => void;
  runGroup: (args: EmbeddingBatchGroupRunArgs<TRequest>) => Promise<void>;
}): Promise<Map<string, number[]>> {
  if (params.requests.length === 0) {
    return new Map();
  }
  const groups = splitBatchRequestsByLimits(params.requests, {
    maxRequests: params.maxRequests,
    maxJsonlBytes: params.maxJsonlBytes,
  });
  const byCustomId = new Map<string, number[]>();
  const pollIntervalMs = resolveEmbeddingBatchPollIntervalMs(params);
  const runGroup = async (group: TRequest[], groupIndex: number, depth = 0): Promise<void> => {
    try {
      await params.runGroup({
        group,
        groupIndex,
        groups: groups.length,
        byCustomId,
        pollIntervalMs,
        timeoutMs: params.timeoutMs,
      });
    } catch (error) {
      if (group.length <= 1 || !params.shouldSplitGroupOnError?.(error, group)) {
        throw error;
      }
      const splitAt = Math.ceil(group.length / 2);
      const parts = [group.slice(0, splitAt), group.slice(splitAt)].filter(
        (part) => part.length > 0,
      );
      params.onSplitGroup?.({
        error,
        group,
        parts,
        groupIndex,
        groups: groups.length,
        depth,
      });
      for (const part of parts) {
        await runGroup(part, groupIndex, depth + 1);
      }
    }
  };
  const tasks = groups.map((group, groupIndex) => async () => {
    await runGroup(group, groupIndex);
  });

  params.debug?.(params.debugLabel, {
    requests: params.requests.length,
    groups: groups.length,
    maxRequests: params.maxRequests,
    maxJsonlBytes: params.maxJsonlBytes,
    wait: params.wait,
    concurrency: params.concurrency,
    pollIntervalMs,
    timeoutMs: params.timeoutMs,
  });

  await runMemoryHostTasksWithConcurrency(tasks, params.concurrency);
  return byCustomId;
}

/** Build normalized batch-group options for provider-specific runners. */
export function buildEmbeddingBatchGroupOptions<TRequest>(
  params: { requests: TRequest[] } & EmbeddingBatchExecutionParams,
  options: { maxRequests: number; maxJsonlBytes?: number; debugLabel: string },
) {
  const pollIntervalMs = resolveEmbeddingBatchPollIntervalMs(params);
  return {
    requests: params.requests,
    maxRequests: options.maxRequests,
    maxJsonlBytes: options.maxJsonlBytes,
    wait: params.wait,
    pollIntervalMs,
    timeoutMs: params.timeoutMs,
    concurrency: params.concurrency,
    debug: params.debug,
    debugLabel: options.debugLabel,
  };
}
