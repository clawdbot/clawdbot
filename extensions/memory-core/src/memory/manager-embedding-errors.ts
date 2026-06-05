// Memory Core plugin module implements manager embedding errors behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

export const MEMORY_EMBEDDING_OPERATION_ERROR_CODE = "MEMORY_EMBEDDING_OPERATION_FAILED";

export type MemoryEmbeddingOperationKind = "query" | "batch" | "structured-batch";

export type MemoryEmbeddingOperationError = Error & {
  code: typeof MEMORY_EMBEDDING_OPERATION_ERROR_CODE;
  operation: MemoryEmbeddingOperationKind;
  providerId?: string;
  cause?: unknown;
};

export function createMemoryEmbeddingOperationError(params: {
  operation: MemoryEmbeddingOperationKind;
  providerId?: string;
  cause: unknown;
}): MemoryEmbeddingOperationError {
  const message = formatErrorMessage(params.cause);
  const error = new Error(message) as MemoryEmbeddingOperationError;
  error.code = MEMORY_EMBEDDING_OPERATION_ERROR_CODE;
  error.operation = params.operation;
  if (params.providerId) {
    error.providerId = params.providerId;
  }
  error.cause = params.cause;
  return error;
}

export function isMemoryEmbeddingOperationError(
  err: unknown,
): err is MemoryEmbeddingOperationError {
  return (
    err instanceof Error &&
    (err as { code?: unknown }).code === MEMORY_EMBEDDING_OPERATION_ERROR_CODE
  );
}
