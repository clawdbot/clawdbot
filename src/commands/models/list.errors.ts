/** Formats an unknown error with stack detail when available. */
export function formatErrorWithStack(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`;
  }
  return String(err);
}
