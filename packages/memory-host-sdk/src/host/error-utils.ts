// Memory Host SDK helper module supports error utils behavior.
import { formatErrorMessage as formatSharedErrorMessage } from "@openclaw/normalization-core/error-coercion";
// Import the canonical redactor directly, not via openclaw-runtime-io: that
// facade pulls the full core runtime (execa reach), and this module sits in the
// memory-core doctor contract closure, which the build guards keep execa-free.
import { redactToolPayloadText } from "../../../../src/logging/redact.js";

/** Format memory-host errors through the canonical formatter and redaction policy. */
export function formatErrorMessage(err: unknown): string {
  // Memory-host errors force redaction and merge operator patterns with defaults,
  // so custom logging policy cannot disable provider-token coverage.
  return formatSharedErrorMessage(err, { redact: redactToolPayloadText });
}
