// Small error formatting helper for scripts that accept unknown thrown values.
/** Return a readable message for Error and non-Error thrown values. */
export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || "Error";
  }
  return String(error);
}

/** Read Error messages unchanged and stringify every other value. */
export function coerceErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** Preserve structured non-Error failures without requiring built workspace packages. */
export function toErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
