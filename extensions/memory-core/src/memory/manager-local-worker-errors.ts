// Memory Core plugin module implements manager local worker errors behavior.
export const LOCAL_EMBEDDING_WORKER_ERROR_CODES = {
  exited: "LOCAL_EMBEDDING_WORKER_EXITED",
  processError: "LOCAL_EMBEDDING_WORKER_PROCESS_ERROR",
  ipcError: "LOCAL_EMBEDDING_WORKER_IPC_ERROR",
} as const;

export type LocalEmbeddingWorkerFailureCode =
  (typeof LOCAL_EMBEDDING_WORKER_ERROR_CODES)[keyof typeof LOCAL_EMBEDDING_WORKER_ERROR_CODES];

export type LocalEmbeddingWorkerFailureError = Error & {
  code: LocalEmbeddingWorkerFailureCode;
};

const LOCAL_EMBEDDING_WORKER_FAILURE_CODES = new Set<string>(
  Object.values(LOCAL_EMBEDDING_WORKER_ERROR_CODES),
);

export function isLocalEmbeddingWorkerFailure(
  err: unknown,
): err is LocalEmbeddingWorkerFailureError {
  return (
    err instanceof Error &&
    LOCAL_EMBEDDING_WORKER_FAILURE_CODES.has(String((err as { code?: unknown }).code))
  );
}
