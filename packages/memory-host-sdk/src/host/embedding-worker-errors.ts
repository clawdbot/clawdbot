// Typed local embedding worker failures for process and IPC lifecycle handling.

/** Stable error codes emitted by the local embedding worker supervisor. */
export const LOCAL_EMBEDDING_WORKER_ERROR_CODES = {
  exited: "LOCAL_EMBEDDING_WORKER_EXITED",
  processError: "LOCAL_EMBEDDING_WORKER_PROCESS_ERROR",
  ipcError: "LOCAL_EMBEDDING_WORKER_IPC_ERROR",
} as const;

/** Error code union for local embedding worker failures. */
type LocalEmbeddingWorkerFailureCode =
  (typeof LOCAL_EMBEDDING_WORKER_ERROR_CODES)[keyof typeof LOCAL_EMBEDDING_WORKER_ERROR_CODES];

/** Cause category for local embedding worker failures. */
type LocalEmbeddingWorkerFailureReason = "exit" | "signal" | "process-error" | "ipc";

/** Error shape returned by the local embedding worker failure factory. */
type LocalEmbeddingWorkerFailureError = Error & {
  code: LocalEmbeddingWorkerFailureCode;
  reason: LocalEmbeddingWorkerFailureReason;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
};

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
