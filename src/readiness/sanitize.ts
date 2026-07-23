import { Buffer } from "node:buffer";
import { redactSensitiveText } from "../logging/redact.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";

const MAX_READINESS_MESSAGE_BYTES = 512;
export const READINESS_REASON_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

export function sanitizeProviderReadinessMessage(value: string): string | undefined {
  const redacted = redactSensitiveText(value, { mode: "tools" }).trim();
  if (!redacted || redacted.includes("\0")) {
    return undefined;
  }
  return Buffer.byteLength(redacted, "utf8") <= MAX_READINESS_MESSAGE_BYTES ? redacted : undefined;
}

export function boundedCoreReadinessMessage(value: string): string {
  const redacted = redactSensitiveText(value, { mode: "tools" }).trim();
  return truncateUtf8Prefix(redacted, MAX_READINESS_MESSAGE_BYTES);
}
