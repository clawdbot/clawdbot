/**
 * Warns once per Codex runtime when an explicitly enabled app is unavailable
 * to the signed-in account.
 */
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { serializeCodexAppInventoryError } from "./app-inventory-cache.js";
import type { CodexAppServerClient } from "./client.js";

type ConfiguredAppAvailabilityCheckParams = {
  client: Pick<CodexAppServerClient, "request">;
  appCacheKey: string;
  requiredAppIds: readonly string[];
  timeoutMs: number;
  signal?: AbortSignal;
};

/** Coalesces live configured-app checks and logs each runtime result once. */
class CodexConfiguredAppAvailabilityMonitor {
  private readonly checks = new Map<string, Promise<void>>();

  check(params: ConfiguredAppAvailabilityCheckParams): Promise<void> {
    const requiredAppIds = [...new Set(params.requiredAppIds)].toSorted();
    if (requiredAppIds.length === 0) {
      return Promise.resolve();
    }
    const checkKey = `${params.appCacheKey}\0${requiredAppIds.join("\0")}`;
    const existing = this.checks.get(checkKey);
    if (existing) {
      return existing;
    }

    const check = this.checkOnce(params, requiredAppIds).catch((error) => {
      this.checks.delete(checkKey);
      embeddedAgentLog.warn("configured Codex app availability check failed", {
        error: serializeCodexAppInventoryError(error),
      });
    });
    this.checks.set(checkKey, check);
    return check;
  }

  private async checkOnce(
    params: ConfiguredAppAvailabilityCheckParams,
    requiredAppIds: readonly string[],
  ): Promise<void> {
    const options = { timeoutMs: params.timeoutMs, signal: params.signal };
    const installed = await params.client.request("app/installed", { forceRefresh: true }, options);
    const installedAppIds = new Set(installed.apps.map((app) => app.id));
    for (const appId of requiredAppIds) {
      if (installedAppIds.has(appId)) {
        continue;
      }
      embeddedAgentLog.warn(
        "required Codex app is unavailable; install or authorize it to expose its tools",
        {
          appId,
          state: "not_installed_or_authorized",
        },
      );
    }
  }
}

const defaultCodexConfiguredAppAvailabilityMonitor = new CodexConfiguredAppAvailabilityMonitor();

/** Checks the apps required by the embedding runtime without changing turn policy. */
export function checkConfiguredCodexAppAvailability(
  params: ConfiguredAppAvailabilityCheckParams,
): Promise<void> {
  return defaultCodexConfiguredAppAvailabilityMonitor.check(params);
}
