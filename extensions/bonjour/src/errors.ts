/**
 * Bonjour error formatting helper. It normalizes Error and non-Error values
 * into concise messages for gateway discovery logs.
 */
/** Format an unknown Bonjour/ciao error value for logs. */
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
