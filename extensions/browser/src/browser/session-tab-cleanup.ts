/**
 * Periodic cleanup for browser tabs tracked to primary OpenClaw sessions.
 */
import {
  isAcpSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
} from "openclaw/plugin-sdk/routing";
import { getRuntimeConfig } from "../config/config.js";
import { resolveBrowserConfig, type ResolvedBrowserTabCleanupConfig } from "./config.js";
import { sweepTrackedBrowserTabs } from "./session-tab-registry.js";

const MIN_SWEEP_INTERVAL_MS = 60_000;

function minutesToMs(minutes: number): number {
  return Math.max(0, Math.floor(minutes * 60_000));
}

/** Returns true for user-facing sessions whose tabs should be tracked for cleanup. */
export function isPrimaryTrackedBrowserSessionKey(sessionKey: string): boolean {
  return (
    !isSubagentSessionKey(sessionKey) &&
    !isCronSessionKey(sessionKey) &&
    !isAcpSessionKey(sessionKey)
  );
}

function resolveBrowserTabCleanupRuntimeConfig(): ResolvedBrowserTabCleanupConfig {
  const cfg = getRuntimeConfig();
  return resolveBrowserConfig(cfg.browser, cfg).tabCleanup;
}

/** Runs one Browser tab cleanup sweep from runtime config or injected test config. */
export async function runTrackedBrowserTabCleanupOnce(params?: {
  now?: number;
  cleanup?: ResolvedBrowserTabCleanupConfig;
  closeTab?: (tab: { targetId: string; baseUrl?: string; profile?: string }) => Promise<void>;
  onWarn?: (message: string) => void;
}): Promise<number> {
  const cleanup = params?.cleanup ?? resolveBrowserTabCleanupRuntimeConfig();
  if (!cleanup.enabled) {
    return 0;
  }
  return await sweepTrackedBrowserTabs({
    now: params?.now,
    idleMs: minutesToMs(cleanup.idleMinutes),
    maxTabsPerSession: cleanup.maxTabsPerSession,
    sessionFilter: isPrimaryTrackedBrowserSessionKey,
    closeTab: params?.closeTab,
    onWarn: params?.onWarn,
  });
}

/** Starts the recurring Browser tab cleanup timer and returns its disposer. */
export function startTrackedBrowserTabCleanupTimer(params: {
  onWarn: (message: string) => void;
}): () => Promise<void> {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> | null = null;

  const schedule = () => {
    if (stopped) {
      return;
    }
    let sweepMinutes = 5;
    try {
      sweepMinutes = resolveBrowserTabCleanupRuntimeConfig().sweepMinutes;
    } catch (err) {
      params.onWarn(`failed to resolve browser tab cleanup config: ${String(err)}`);
    }
    timer = setTimeout(run, Math.max(MIN_SWEEP_INTERVAL_MS, minutesToMs(sweepMinutes)));
    timer.unref?.();
  };

  const run = () => {
    if (stopped) {
      return;
    }
    if (!running) {
      running = runTrackedBrowserTabCleanupOnce({ onWarn: params.onWarn }).finally(() => {
        running = null;
        schedule();
      });
      return;
    }
    schedule();
  };

  schedule();
  return async () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await running?.catch(() => {});
  };
}
