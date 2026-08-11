import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage } from "../../infra/errors.js";
import { redactSensitiveText } from "../../logging/redact.js";

export function boundedWorkerError(error: unknown): string {
  const redacted = redactSensitiveText(formatErrorMessage(error), { mode: "tools" })
    .replace(/\s+/g, " ")
    .trim();
  return truncateUtf16Safe(redacted || "unknown error", 1_024);
}
