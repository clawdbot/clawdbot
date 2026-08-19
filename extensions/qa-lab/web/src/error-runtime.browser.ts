import { formatErrorMessage as formatSharedErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { redactCaptureInlineSecretPairs } from "./ui-render-capture-redaction.js";

export function formatErrorMessage(error: unknown): string {
  return formatSharedErrorMessage(error, { redact: redactCaptureInlineSecretPairs });
}
