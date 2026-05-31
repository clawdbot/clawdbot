import type { OpenClawConfig } from "./config/types.openclaw.js";
import { runBestEffortCleanup } from "./infra/non-fatal-cleanup.js";
import { closeTrackedBrowserTabsForSessions } from "./plugin-sdk/browser-maintenance.js";

function normalizeSessionKeys(sessionKeys: string[]): string[] {
  const keys = new Set<string>();
  for (const sessionKey of sessionKeys) {
    const normalized = sessionKey.trim();
    if (normalized) {
      keys.add(normalized);
    }
  }
  return [...keys];
}

function isBrowserCleanupDisabled(cfg: OpenClawConfig | undefined): boolean {
  return cfg?.browser?.enabled === false || cfg?.plugins?.entries?.browser?.enabled === false;
}

export async function cleanupBrowserSessionsForLifecycleEnd(params: {
  cfg?: OpenClawConfig;
  sessionKeys: string[];
  onWarn?: (message: string) => void;
  onError?: (error: unknown) => void;
}): Promise<void> {
  if (isBrowserCleanupDisabled(params.cfg)) {
    return;
  }
  const sessionKeys = normalizeSessionKeys(params.sessionKeys);
  if (sessionKeys.length === 0) {
    return;
  }
  await runBestEffortCleanup({
    cleanup: async () => {
      await closeTrackedBrowserTabsForSessions({
        sessionKeys,
        onWarn: params.onWarn,
      });
    },
    onError: params.onError,
  });
}
