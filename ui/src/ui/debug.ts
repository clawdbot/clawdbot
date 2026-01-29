/**
 * Debug logging utility for the UI.
 * Controlled by the debugLogs setting in UI settings.
 * Can also be enabled via:
 *   - localStorage.setItem('moltbot-ui-debug', 'true')
 *   - window.MOLTBOT_UI_DEBUG = true
 */

declare global {
  interface Window {
    MOLTBOT_UI_DEBUG?: boolean;
  }
}

let debugEnabled = false;

export function setDebugEnabled(enabled: boolean): void {
  debugEnabled = enabled;
}

export function isDebugEnabled(): boolean {
  if (debugEnabled) return true;
  if (typeof window !== "undefined") {
    if (window.MOLTBOT_UI_DEBUG) return true;
    try {
      return localStorage.getItem("moltbot-ui-debug") === "true";
    } catch {
      return false;
    }
  }
  return false;
}

export function debug(message: string, ...args: unknown[]): void {
  if (isDebugEnabled()) {
    console.log(`[DEBUG UI] ${message}`, ...args);
  }
}
