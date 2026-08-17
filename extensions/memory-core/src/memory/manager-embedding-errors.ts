// Memory Core plugin module implements manager embedding errors behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

const MEMORY_EMBEDDING_OPERATION_ERROR_CODE = "MEMORY_EMBEDDING_OPERATION_FAILED";

type MemoryEmbeddingOperationKind = "query" | "batch" | "structured-batch";

type MemoryEmbeddingOperationError = Error & {
  code: typeof MEMORY_EMBEDDING_OPERATION_ERROR_CODE;
  operation: MemoryEmbeddingOperationKind;
  providerId?: string;
  cause?: unknown;
  /** Set when this rejection short-circuited a known billing cooldown instead of calling the network. */
  skippedDueToCooldown?: boolean;
};

export function createMemoryEmbeddingOperationError(params: {
  operation: MemoryEmbeddingOperationKind;
  providerId?: string;
  cause: unknown;
  skippedDueToCooldown?: boolean;
}): MemoryEmbeddingOperationError {
  const message = formatErrorMessage(params.cause);
  const error = new Error(message) as MemoryEmbeddingOperationError;
  error.code = MEMORY_EMBEDDING_OPERATION_ERROR_CODE;
  error.operation = params.operation;
  if (params.providerId) {
    error.providerId = params.providerId;
  }
  error.cause = params.cause;
  if (params.skippedDueToCooldown) {
    error.skippedDueToCooldown = true;
  }
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

/** Whether `err` short-circuited a known billing cooldown rather than failing anew. */
function isMemorySyncCooldownSkip(err: unknown): boolean {
  return isMemoryEmbeddingOperationError(err) && err.skippedDueToCooldown === true;
}

/**
 * Logs a background memory-sync failure at the right level: a cooldown-skip is an
 * already-reported, expected state (see the billing cooldown in manager-embedding-ops.ts),
 * not a new failure, so every async sync entrypoint (session updates, on-search sync,
 * startup catchup) must demote it to debug instead of re-warning on every cycle. Pass an
 * already-formatted `message` when the caller needs redaction; defaults to `String(err)`.
 */
export function logMemorySyncOutcome(
  log: { warn: (message: string) => void; debug: (message: string) => void },
  label: string,
  err: unknown,
  message = String(err),
): void {
  if (isMemorySyncCooldownSkip(err)) {
    log.debug(`memory sync skipped (${label}): ${message}`);
    return;
  }
  log.warn(`memory sync failed (${label}): ${message}`);
}
