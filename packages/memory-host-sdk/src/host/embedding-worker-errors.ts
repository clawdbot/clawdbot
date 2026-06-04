// Typed local embedding worker failures for process and IPC lifecycle handling.

/** Stable error codes emitted by the local embedding worker supervisor. */
export const LOCAL_EMBEDDING_WORKER_ERROR_CODES = {
  exited: "LOCAL_EMBEDDING_WORKER_EXITED",
  processError: "LOCAL_EMBEDDING_WORKER_PROCESS_ERROR",
  ipcError: "LOCAL_EMBEDDING_WORKER_IPC_ERROR",
} as const;

/** Error code union for local embedding worker failures. */
export type LocalEmbeddingWorkerFailureCode =
  (typeof LOCAL_EMBEDDING_WORKER_ERROR_CODES)[keyof typeof LOCAL_EMBEDDING_WORKER_ERROR_CODES];

/** Cause category for local embedding worker failures. */
export type LocalEmbeddingWorkerFailureReason = "exit" | "signal" | "process-error" | "ipc";

/** Error shape used by callers that need retry/status decisions. */
export type LocalEmbeddingWorkerFailureError = Error & {
  code: LocalEmbeddingWorkerFailureCode;
  reason: LocalEmbeddingWorkerFailureReason;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
};

const LOCAL_EMBEDDING_WORKER_FAILURE_CODES = new Set<string>(
  Object.values(LOCAL_EMBEDDING_WORKER_ERROR_CODES),
);

/** Create a local embedding worker failure with stable metadata fields. */
export function createLocalEmbeddingWorkerFailureError(params: {
  message: string;
  code: LocalEmbeddingWorkerFailureCode;
  reason: LocalEmbeddingWorkerFailureReason;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  cause?: unknown;
}): LocalEmbeddingWorkerFailureError {
  return Object.assign(new Error(params.message), {
    code: params.code,
    reason: params.reason,
    ...(params.exitCode !== undefined ? { exitCode: params.exitCode } : {}),
    ...(params.signal !== undefined ? { signal: params.signal } : {}),
    ...(params.cause !== undefined ? { cause: params.cause } : {}),
  });
}

/** Narrow unknown errors to local embedding worker lifecycle failures. */
export function isLocalEmbeddingWorkerFailure(
  err: unknown,
): err is LocalEmbeddingWorkerFailureError {
  return (
    err instanceof Error &&
    LOCAL_EMBEDDING_WORKER_FAILURE_CODES.has(String((err as { code?: unknown }).code))
  );
}
