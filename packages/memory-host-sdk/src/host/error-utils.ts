// Memory Host SDK helper module supports error utils behavior.
import { formatErrorMessage as formatSharedErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { redactSensitiveText } from "./openclaw-runtime-io.js";

/** Format memory-host errors through the canonical formatter and redaction policy. */
export function formatErrorMessage(err: unknown): string {
  // Memory-host errors must redact unconditionally, even when operator logging
  // redaction is off; this preserves the previous local policy's invariant.
  return formatSharedErrorMessage(err, {
    redact: (text) => redactSensitiveText(text, { mode: "tools" }),
  });
}
