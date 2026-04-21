/**
 * QQBot debug logging utilities.
 * QQBot 调试日志工具。
 *
 * Only outputs when the QQBOT_DEBUG environment variable is set,
 * preventing user message content from leaking in production logs.
 *
 * Self-contained within engine/ — no framework SDK dependency.
 */

const isDebug = () => !!process.env.QQBOT_DEBUG;

/** Debug-level log; only outputs when QQBOT_DEBUG is enabled. */
export function debugLog(...args: unknown[]): void {
  if (isDebug()) {
    console.log(...args);
  }
}

/** Debug-level warning; only outputs when QQBOT_DEBUG is enabled. */
export function debugWarn(...args: unknown[]): void {
  if (isDebug()) {
    console.warn(...args);
  }
}

/** Debug-level error; only outputs when QQBOT_DEBUG is enabled. */
export function debugError(...args: unknown[]): void {
  if (isDebug()) {
    console.error(...args);
  }
}
