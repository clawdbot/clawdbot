export function formatBonjourError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message || String(err);
    return err.name && err.name !== "Error" ? `${err.name}: ${msg}` : msg;
  }
  return String(err);
}
