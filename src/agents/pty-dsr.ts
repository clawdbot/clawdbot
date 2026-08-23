/**
 * Terminal device-status-report helpers.
 * Intercepts cursor-position requests from PTY output and generates compact
 * responses when a real terminal cannot answer them.
 */
const ESC = String.fromCharCode(0x1b);
const DSR_PATTERN = new RegExp(`${ESC}\\[\\??6n`, "g");

/** Removes terminal device-status-report cursor requests and counts them. */
export function stripDsrRequests(input: string): { cleaned: string; requests: number } {
  let requests = 0;
  const cleaned = input.replace(DSR_PATTERN, () => {
    requests += 1;
    return "";
  });
  return { cleaned, requests };
}

/** Builds a terminal cursor-position response for intercepted DSR requests. */
export function buildCursorPositionResponse(row = 1, col = 1): string {
  return `\x1b[${row};${col}R`;
}
