import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { splitBatchRequests } from "./batch-utils.js";

export type EmbeddingBatchExecutionParams = {
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  concurrency: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
};

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
  }) => Promise<void>;
}): Promise<Map<string, number[]>> {
  if (params.requests.length === 0) {
    return new Map();
  }
  const groups = splitBatchRequests(params.requests, params.maxRequests);
  const byCustomId = new Map<string, number[]>();
  const tasks = groups.map((group, groupIndex) => async () => {
    await params.runGroup({ group, groupIndex, groups: groups.length, byCustomId });
  });

  params.debug?.(params.debugLabel, {
    requests: params.requests.length,
    groups: groups.length,
    wait: params.wait,
    concurrency: params.concurrency,
    pollIntervalMs: params.pollIntervalMs,
    timeoutMs: params.timeoutMs,
  });

  const { firstError, hasError } = await runTasksWithConcurrency({
    tasks,
    limit: params.concurrency,
    errorMode: "stop",
  });
  if (hasError) {
    throw firstError;
  }
  return byCustomId;
}

export function buildEmbeddingBatchGroupOptions<TRequest>(
  params: { requests: TRequest[] } & EmbeddingBatchExecutionParams,
  options: { maxRequests: number; debugLabel: string },
) {
  return {
    requests: params.requests,
    maxRequests: options.maxRequests,
    wait: params.wait,
    pollIntervalMs: params.pollIntervalMs,
    timeoutMs: params.timeoutMs,
    concurrency: params.concurrency,
    debug: params.debug,
    debugLabel: options.debugLabel,
  };
}
