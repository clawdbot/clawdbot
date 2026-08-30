import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { SESSION_LIFECYCLE_CHANGED_ERROR_REASON } from "../../config/sessions/lifecycle.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { SessionWorktreeLifecycleError } from "../../sessions/session-worktree-lifecycle.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { sessionLog } from "./sessions-shared.js";

export function unexpectedPatchError(key: string, error: unknown): ErrorShape {
  if (error instanceof SessionMutationAuthorizationChangedError) {
    return error.error;
  }
  if (error instanceof SessionWorktreeLifecycleError) {
    return error.reason === "session-changed"
      ? sessionChangedError(key)
      : errorShape(ErrorCodes.UNAVAILABLE, error.message, { retryable: true });
  }
  sessionLog.warn(`sessions.patch: target failed for ${key}: ${formatErrorMessage(error)}`);
  const message = "Session patch failed unexpectedly. Retry the request.";
  return errorShape(ErrorCodes.UNAVAILABLE, message, { retryable: true });
}

export function sessionChangedError(key: string): ErrorShape {
  return errorShape(ErrorCodes.INVALID_REQUEST, `Session ${key} changed before patch. Retry.`, {
    details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON },
  });
}

export function createCommitGuard(key: string, assertCurrent: (() => void) | undefined) {
  return (): ErrorShape | undefined => {
    try {
      assertCurrent?.();
      return undefined;
    } catch (error) {
      return error instanceof SessionMutationAuthorizationChangedError
        ? error.error
        : unexpectedPatchError(key, error);
    }
  };
}
