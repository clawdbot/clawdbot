export function formatBonjourError(err: unknown): string {
  if (err instanceof Error) {
    const trimmedMessage = err.message.trim();
    const msg = trimmedMessage || err.name || String(err).trim();
    if (err.name && err.name !== "Error") {
      return msg === err.name ? err.name : `${err.name}: ${msg}`;
    }
    return msg;
  }
  return String(err);
}
