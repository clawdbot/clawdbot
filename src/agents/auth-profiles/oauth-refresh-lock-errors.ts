/**
 * OAuth refresh lock error helpers.
 * Distinguishes global refresh-lock contention from auth-store lock timeouts
 * and builds the user-facing contention error.
 */
import { FILE_LOCK_TIMEOUT_ERROR_CODE } from "../../infra/file-lock.js";

/** Returns true when an error came from the global OAuth refresh lock. */
export function isGlobalRefreshLockTimeoutError(error: unknown, lockPath: string): boolean {
  const candidate =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; lockPath?: unknown })
      : undefined;
  return (
    candidate?.code === FILE_LOCK_TIMEOUT_ERROR_CODE && candidate.lockPath === `${lockPath}.lock`
  );
}

/** Builds the user-facing OAuth refresh contention error. */
export function buildRefreshContentionError(params: {
  provider: string;
  profileId: string;
  cause: unknown;
}): Error & { code: "refresh_contention"; cause: unknown } {
  return Object.assign(
    new Error(
      `OAuth refresh failed (refresh_contention): another process is already refreshing ${params.provider} for ${params.profileId}. Please wait for the in-flight refresh to finish and retry.`,
      { cause: params.cause },
    ),
    {
      code: "refresh_contention" as const,
      cause: params.cause,
    },
  );
}
