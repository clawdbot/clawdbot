/**
 * Debug logging utility for QQBot plugin.
 *
 * Only outputs when QQBOT_DEBUG environment variable is set.
 * Prevents leaking user message content in production logs.
 */

const isDebug = () => !!process.env.QQBOT_DEBUG;

export function debugLog(...args: unknown[]): void {
  if (isDebug()) {
    console.log(...args);
  }
}

export function debugWarn(...args: unknown[]): void {
  if (isDebug()) {
    console.warn(...args);
  }
}

export function debugError(...args: unknown[]): void {
  if (isDebug()) {
    console.error(...args);
  }
}
