export function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    let formatted = err.message || err.name || "Error";
    let cause: unknown = err.cause;
    const seen = new Set<unknown>([err]);
    while (cause && !seen.has(cause)) {
      seen.add(cause);
      if (cause instanceof Error) {
        if (cause.message) {
          formatted += ` | ${cause.message}`;
        }
        cause = cause.cause;
        continue;
      }
      if (typeof cause === "string") {
        formatted += ` | ${cause}`;
      }
      break;
    }
    return formatted;
  }
  if (typeof err === "string") {
    return err;
  }
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return String(err);
  }
  try {
    return JSON.stringify(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}
