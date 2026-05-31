import { resolveSafeTimeoutDelayMs } from "../../../gateway-client/src/timeouts.js";
import { splitBatchRequests } from "./batch-utils.js";
import { runWithConcurrency } from "./internal.js";

export type EmbeddingBatchExecutionParams = {
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  concurrency: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
};

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

export async function runEmbeddingBatchGroups<TRequest>(params: {
  requests: TRequest[];
  maxRequests: number;
  wait: EmbeddingBatchExecutionParams["wait"];
  pollIntervalMs: EmbeddingBatchExecutionParams["pollIntervalMs"];
  timeoutMs: EmbeddingBatchExecutionParams["timeoutMs"];
  concurrency: EmbeddingBatchExecutionParams["concurrency"];
  debugLabel: string;
  debug?: EmbeddingBatchExecutionParams["debug"];
  runGroup: (args: {
    group: TRequest[];
    groupIndex: number;
    groups: number;
    byCustomId: Map<string, number[]>;
    pollIntervalMs: number;
    timeoutMs: number;
  }) => Promise<void>;
}): Promise<Map<string, number[]>> {
  if (params.requests.length === 0) {
    return new Map();
  }
  const groups = splitBatchRequests(params.requests, params.maxRequests);
  const byCustomId = new Map<string, number[]>();
  const pollIntervalMs = resolveEmbeddingBatchPollIntervalMs(params);
  const tasks = groups.map((group, groupIndex) => async () => {
    await params.runGroup({
      group,
      groupIndex,
      groups: groups.length,
      byCustomId,
      pollIntervalMs,
      timeoutMs: params.timeoutMs,
    });
  });

  params.debug?.(params.debugLabel, {
    requests: params.requests.length,
    groups: groups.length,
    wait: params.wait,
    concurrency: params.concurrency,
    pollIntervalMs,
    timeoutMs: params.timeoutMs,
  });

  await runWithConcurrency(tasks, params.concurrency);
  return byCustomId;
}

export function buildEmbeddingBatchGroupOptions<TRequest>(
  params: { requests: TRequest[] } & EmbeddingBatchExecutionParams,
  options: { maxRequests: number; debugLabel: string },
) {
  const pollIntervalMs = resolveEmbeddingBatchPollIntervalMs(params);
  return {
    requests: params.requests,
    maxRequests: options.maxRequests,
    wait: params.wait,
    pollIntervalMs,
    timeoutMs: params.timeoutMs,
    concurrency: params.concurrency,
    debug: params.debug,
    debugLabel: options.debugLabel,
  };
}
