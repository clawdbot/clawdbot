// Small error formatting helper for scripts that accept unknown thrown values.
/** Return a readable message for Error and non-Error thrown values. */
export function formatErrorMessage(error) {
  if (error instanceof Error) {
    return error.message || error.name || "Error";
  }
  return String(error);
}
