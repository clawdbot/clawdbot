import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage } from "../../infra/errors.js";
import { redactSensitiveText } from "../../logging/redact.js";

type WorkerEnvironmentServiceErrorCode =
  | "profile_not_found"
  | "provider_not_found"
  | "environment_not_found"
  | "invalid_profile"
  | "invalid_state"
  | "desktop_app_not_found"
  | "unsupported_platform"
  | "launcher_failure"
  | "provider_failure"
  | "bootstrap_failure";

export class WorkerEnvironmentServiceError extends Error {
  constructor(
    readonly code: WorkerEnvironmentServiceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const createWorkerEnvironmentServiceError = (
  code: WorkerEnvironmentServiceErrorCode,
  message: string,
) => new WorkerEnvironmentServiceError(code, message);

export function boundedWorkerError(error: unknown, maxChars = 1_024): string {
  const redacted = redactSensitiveText(formatErrorMessage(error), { mode: "tools" })
    .replace(/\s+/g, " ")
    .trim();
  return truncateUtf16Safe(redacted || "unknown error", maxChars);
}
