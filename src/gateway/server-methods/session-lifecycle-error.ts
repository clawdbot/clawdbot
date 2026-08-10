import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { isSessionLifecycleBlockedError } from "../../sessions/session-lifecycle-blocker.js";
import { formatForLog } from "../ws-log.js";

export function sessionWorkAdmissionErrorShape(error: unknown): ErrorShape {
  if (isSessionLifecycleBlockedError(error)) {
    return errorShape(ErrorCodes.UNAVAILABLE, error.message, { retryable: true });
  }
  return errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(error));
}
