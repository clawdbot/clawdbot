import { formatErrorMessage as formatSharedErrorMessage } from "./error-coercion.js";

// Browser owners apply their redaction policy at the UI boundary.
export function formatErrorMessage(error: unknown): string {
  return formatSharedErrorMessage(error, { redact: (text) => text });
}
