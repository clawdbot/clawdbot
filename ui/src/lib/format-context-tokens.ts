/**
 * Context-window display helpers.
 *
 * Compact context counts use binary kilo-tokens (÷1024), not decimal ÷1000,
 * so a 262144 window renders as 256k instead of the misleading 262.1k.
 */

const CONTEXT_TOKEN_K = 1024;
const CONTEXT_TOKEN_M = 1024 * 1024;

/** Format a token count for context-usage UI (binary k / M). */
export function formatContextTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) {
    return "0";
  }
  const value = Math.trunc(tokens);
  if (value < CONTEXT_TOKEN_K) {
    return String(value);
  }
  if (value >= CONTEXT_TOKEN_M) {
    const millions = value / CONTEXT_TOKEN_M;
    if (Number.isInteger(millions)) {
      return `${millions}M`;
    }
    const fixed = millions.toFixed(1).replace(/\.0$/, "");
    return `${fixed}M`;
  }
  const thousands = value / CONTEXT_TOKEN_K;
  if (Number.isInteger(thousands)) {
    return `${thousands}k`;
  }
  return `${thousands.toFixed(1).replace(/\.0$/, "")}k`;
}

/** Format an exact token integer with locale grouping for context popovers. */
export function formatContextTokenExact(tokens: number, locale?: string): string {
  if (!Number.isFinite(tokens) || tokens < 0) {
    return "0";
  }
  return Math.trunc(tokens).toLocaleString(locale);
}
