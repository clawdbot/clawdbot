// Batch status helpers shared by remote embedding providers.

const TERMINAL_FAILURE_STATES = new Set(["failed", "expired", "cancelled", "canceled"]);

/** Minimal provider batch status used for completion and terminal-failure checks. */
type BatchStatusLike = {
  id?: string;
  status?: string;
  output_file_id?: string | null;
  error_file_id?: string | null;
};

/** File ids returned once a batch has completed. */
export type BatchCompletionResult = {
  outputFileId: string;
  errorFileId?: string;
};

/** Convert a completed provider status payload into output/error file ids. */
export function resolveBatchCompletionFromStatus(params: {
  provider: string;
  batchId: string;
  status: BatchStatusLike;
}): BatchCompletionResult {
  if (!params.status.output_file_id) {
    throw new Error(`${params.provider} batch ${params.batchId} completed without output file`);
  }
  return {
    outputFileId: params.status.output_file_id,
    errorFileId: params.status.error_file_id ?? undefined,
  };
}

/** Throw when a provider reports a terminal failure, including error-file detail if available. */
export async function throwIfBatchTerminalFailure(params: {
  provider: string;
  status: BatchStatusLike;
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
  status: BatchStatusLike;
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
