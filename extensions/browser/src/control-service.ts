/**
 * Browser control service lifecycle for plugin-managed, in-process operation.
 */
import {
  createBrowserControlContext,
  ensureBrowserControlRuntime,
  getBrowserControlState,
  stopBrowserControlRuntime,
  withBrowserControlStart,
} from "./browser-control-state.js";
import { loadBrowserConfigForRuntimeRefresh } from "./browser/config-refresh-source.js";
import { resolveBrowserConfig, resolveProfile } from "./browser/config.js";
import { ensureBrowserControlAuth } from "./browser/control-auth.js";
import { getExtensionRelayModule } from "./browser/extension-relay.runtime.js";
import type { BrowserServerState } from "./browser/server-context.js";
import { getRuntimeConfig } from "./config/config.js";
import { createSubsystemLogger } from "./logging/subsystem.js";
import { isDefaultBrowserPluginEnabled } from "./plugin-enabled.js";

const log = createSubsystemLogger("browser");
const logService = log.child("service");

async function startBrowserControlServiceUnlocked(): Promise<BrowserServerState | null> {
  const current = getBrowserControlState();
  if (current) {
    return current;
  }

  const cfg = getRuntimeConfig();
  const browserCfg = loadBrowserConfigForRuntimeRefresh();
  if (!isDefaultBrowserPluginEnabled(browserCfg)) {
    return null;
  }
  let resolved = resolveBrowserConfig(browserCfg.browser, browserCfg);
  if (!resolved.enabled) {
    return null;
  }
  try {
    const ensured = await ensureBrowserControlAuth({ cfg });
    if (ensured.generatedToken) {
      logService.info("No browser auth configured; generated gateway.auth.token automatically.");
    }
  } catch (err) {
    logService.warn(`failed to auto-configure browser auth: ${String(err)}`);
  }

  // Ensure the host-local relay secret exists before profiles are consumed so
  // the extension cdpUrl carries auth. Works identically on the gateway host
  // and on a browser node host — each owns its own secret.
  const hasExtensionProfiles = Object.values(resolved.profiles).some(
    (profile) => profile.driver === "extension",
  );
  if (hasExtensionProfiles) {
    const { ensureExtensionRelayToken } = await import("./browser/extension-relay/relay-auth.js");
    ensureExtensionRelayToken();
    const refreshed = loadBrowserConfigForRuntimeRefresh();
    resolved = resolveBrowserConfig(refreshed.browser, refreshed);
  }

  const state = await ensureBrowserControlRuntime({
    server: null,
    port: resolved.controlPort,
    resolved,
    owner: "service",
    onWarn: (message) => logService.warn(message),
  });

  // Extension relays listen from service start so the Chrome extension can
  // (re)connect before the first agent browser request arrives.
  if (hasExtensionProfiles) {
    const { startConfiguredExtensionRelays } = await getExtensionRelayModule();
    await startConfiguredExtensionRelays(
      state,
      (name) => resolveProfile(resolved, name),
      (message) => logService.warn(message),
    );
  }

  logService.info(
    `Browser control service ready (profiles=${Object.keys(resolved.profiles).length})`,
  );
  return state;
}

/** Starts Browser control without binding the HTTP server when config enables it. */
export async function startBrowserControlServiceFromConfig(): Promise<BrowserServerState | null> {
  return await withBrowserControlStart(startBrowserControlServiceUnlocked);
}

/** Stops the in-process Browser control service runtime. */
export async function stopBrowserControlService(): Promise<void> {
  await stopBrowserControlRuntime({
    requestedBy: "service",
    onWarn: (message) => logService.warn(message),
  });
}

/** Re-export Browser control context accessors for gateway-local dispatch. */
export { createBrowserControlContext, getBrowserControlState };
