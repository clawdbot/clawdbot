// Batch status helpers shared by remote embedding providers.
import type { EmbeddingBatchStatus } from "./batch-provider-common.js";

const TERMINAL_FAILURE_STATES = new Set(["failed", "expired", "cancelled", "canceled"]);

/** File ids returned once a batch has completed. */
export type BatchCompletionResult = {
  outputFileId: string;
  errorFileId?: string;
};

/** Convert a completed provider status payload into output/error file ids. */
export function resolveBatchCompletionFromStatus(params: {
  provider: string;
  batchId: string;
  status: EmbeddingBatchStatus;
}): BatchCompletionResult {
  if (!params.status.output_file_id) {
    throw new Error(`${params.provider} batch ${params.batchId} completed without output file`);
  }
  return {
    outputFileId: params.status.output_file_id,
    errorFileId: params.status.error_file_id ?? undefined,
  };
}

/** Fail a completed partial/all-error batch before requiring its success file. */
export async function throwIfBatchCompletionError(params: {
  provider: string;
  status: EmbeddingBatchStatus;
  readError: (errorFileId: string) => Promise<string | undefined>;
}): Promise<void> {
  if (params.status.status !== "completed" || !params.status.error_file_id) {
    return;
  }
  const detail = await params.readError(params.status.error_file_id);
  throw new Error(
    `${params.provider} batch ${params.status.id ?? "<unknown>"} completed: ${detail ?? "provider error file present"}`,
  );
}

/** Throw when a provider reports a terminal failure, including error-file detail if available. */
export async function throwIfBatchTerminalFailure(params: {
  provider: string;
  status: EmbeddingBatchStatus;
  readError: (errorFileId: string) => Promise<string | undefined>;
}): Promise<void> {
  const state = params.status.status ?? "unknown";
  if (!TERMINAL_FAILURE_STATES.has(state)) {
    return;
  }
  const detail = params.status.error_file_id
    ? await params.readError(params.status.error_file_id)
    : undefined;
  const suffix = detail ? `: ${detail}` : "";
  throw new Error(`${params.provider} batch ${params.status.id ?? "<unknown>"} ${state}${suffix}`);
}

/** Resolve the completed batch files, optionally waiting according to caller policy. */
export async function resolveCompletedBatchResult(params: {
  provider: string;
  status: EmbeddingBatchStatus;
  wait: boolean;
  waitForBatch: () => Promise<BatchCompletionResult>;
}): Promise<BatchCompletionResult> {
  const batchId = params.status.id ?? "<unknown>";
  if (!params.wait && params.status.status !== "completed") {
    throw new Error(
      `${params.provider} batch ${batchId} submitted; enable remote.batch.wait to await completion`,
    );
  }
  const completed =
    params.status.status === "completed"
      ? resolveBatchCompletionFromStatus({
          provider: params.provider,
          batchId,
          status: params.status,
        })
      : await params.waitForBatch();
  if (!completed.outputFileId) {
    throw new Error(`${params.provider} batch ${batchId} completed without output file`);
  }
  return completed;
}

/**
 * Share compatible status transitions while callers retain the canonical
 * deadline and transport owners; only a supplied backoff policy retries reads.
 */
export async function waitForEmbeddingBatch<TStatus extends EmbeddingBatchStatus>(params: {
  provider: string;
  batchId: string;
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
  initial?: TStatus;
  fetchStatus: (signal: AbortSignal) => Promise<TStatus>;
  resolveTimeoutMs: () => number;
  waitForPoll: (delayMs: number) => Promise<void>;
  readError: (errorFileId: string) => Promise<string | undefined>;
  backoff?: {
    maxDelayMs: number;
    shouldRetry: (error: unknown) => boolean;
    formatError: (error: unknown) => string;
    formatProgress: (status: TStatus) => string;
  };
}): Promise<BatchCompletionResult> {
  const label = `${params.provider} batch ${params.batchId}`;
  const backoff = params.backoff;
  const maxDelayMs = backoff
    ? Math.max(params.pollIntervalMs, Math.min(params.timeoutMs, backoff.maxDelayMs))
    : params.pollIntervalMs;
  let nextPollDelayMs = params.pollIntervalMs;
  const nextDelayMs = () => {
    const delay = nextPollDelayMs;
    nextPollDelayMs = Math.min(maxDelayMs, delay * 2);
    return delay;
  };
  let current: TStatus | undefined = params.initial;
  while (true) {
    let status: TStatus;
    let statusSignal: AbortSignal | undefined;
    try {
      if (current) {
        status = current;
      } else {
        statusSignal = AbortSignal.timeout(params.resolveTimeoutMs());
        status = await params.fetchStatus(statusSignal);
      }
    } catch (error) {
      if (statusSignal?.aborted) {
        throw new Error(`${label} timed out after ${params.timeoutMs}ms`, { cause: error });
      }
      if (!params.wait || !backoff?.shouldRetry(error)) {
        throw error;
      }
      const delayMs = nextDelayMs();
      params.debug?.(
        `${label} status check failed: ${backoff.formatError(error)}; waiting up to ${delayMs}ms`,
      );
      try {
        await params.waitForPoll(delayMs);
        params.resolveTimeoutMs();
      } catch {
        throw new Error(`${label} timed out after ${params.timeoutMs}ms`, { cause: error });
      }
      current = undefined;
      continue;
    }
    const state = status.status ?? "unknown";
    await throwIfBatchCompletionError({
      provider: params.provider,
      status: { ...status, id: params.batchId },
      readError: params.readError,
    });
    if (state === "completed") {
      return resolveBatchCompletionFromStatus({
        provider: params.provider,
        batchId: params.batchId,
        status,
      });
    }
    await throwIfBatchTerminalFailure({
      provider: params.provider,
      status: { ...status, id: params.batchId },
      readError: params.readError,
    });
    if (!params.wait) {
      throw new Error(`${label} still ${state}; wait disabled`);
    }
    // Fixed polling resolves remaining time before logging; backoff logs its
    // requested delay and lets the shared wait clamp it afterward.
    const waitMs = backoff
      ? nextDelayMs()
      : Math.min(params.pollIntervalMs, params.resolveTimeoutMs());
    params.debug?.(
      backoff
        ? `${label} ${state}${backoff.formatProgress(status)}; waiting up to ${waitMs}ms`
        : `${label} ${state}; waiting ${waitMs}ms`,
    );
    await params.waitForPoll(waitMs);
    params.resolveTimeoutMs();
    current = undefined;
  }
}
