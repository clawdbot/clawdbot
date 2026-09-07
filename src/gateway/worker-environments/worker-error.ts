import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage } from "../../infra/errors.js";
import { redactSensitiveText } from "../../logging/redact.js";

export function boundedWorkerError(error: unknown, maxChars = 1_024): string {
  const redacted = redactSensitiveText(formatErrorMessage(error), { mode: "tools" })
    .replace(/\s+/g, " ")
    .trim();
  const message = redacted || "unknown error";
  const limit = Math.max(0, Math.floor(maxChars));
  const marker = " ... ";
  if (message.length <= limit || limit <= marker.length) {
    return truncateUtf16Safe(message, limit);
  }
  // Keep the operation context and terminal diagnosis when a provider's output is bounded again.
  const headChars = Math.floor((limit - marker.length) / 2);
  const tailChars = limit - marker.length - headChars;
  return `${sliceUtf16Safe(message, 0, headChars).trimEnd()}${marker}${sliceUtf16Safe(message, -tailChars).trimStart()}`.trim();
}
