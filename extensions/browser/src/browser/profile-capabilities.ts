/**
 * Browser profile capability resolution.
 *
 * Derives transport and driver capability flags used by routes and the Browser
 * tool to choose CDP, Playwright, or Chrome MCP behavior.
 */
import type { ResolvedBrowserProfile } from "./config.js";

type BrowserProfileMode = "local-managed" | "local-existing-session" | "remote-cdp";

type BrowserProfileCapabilities = {
  mode: BrowserProfileMode;
  isRemote: boolean;
  /** Profile uses the Chrome DevTools MCP server (existing-session driver). */
  usesChromeMcp: boolean;
  usesPersistentPlaywright: boolean;
  supportsPerTabWs: boolean;
  supportsJsonTabEndpoints: boolean;
  supportsReset: boolean;
  supportsManagedTabLimit: boolean;
};

/** Return feature capabilities for a resolved browser profile. */
export function getBrowserProfileCapabilities(
  profile: ResolvedBrowserProfile,
): BrowserProfileCapabilities {
  if (profile.driver === "existing-session") {
    return {
      mode: "local-existing-session",
      isRemote: false,
      usesChromeMcp: true,
      usesPersistentPlaywright: false,
      supportsPerTabWs: false,
      supportsJsonTabEndpoints: false,
      supportsReset: false,
      supportsManagedTabLimit: false,
    };
  }

  if (!profile.cdpIsLoopback) {
    return {
      mode: "remote-cdp",
      isRemote: true,
      usesChromeMcp: false,
      usesPersistentPlaywright: true,
      supportsPerTabWs: false,
      supportsJsonTabEndpoints: false,
      supportsReset: false,
      supportsManagedTabLimit: false,
    };
  }

  return {
    mode: "local-managed",
    isRemote: false,
    usesChromeMcp: false,
    usesPersistentPlaywright: false,
    supportsPerTabWs: true,
    supportsJsonTabEndpoints: true,
    supportsReset: true,
    supportsManagedTabLimit: true,
  };
}

/** Resolve the default snapshot format for a profile and available drivers. */
export function resolveDefaultSnapshotFormat(params: {
  profile: ResolvedBrowserProfile;
  hasPlaywright: boolean;
  explicitFormat?: "ai" | "aria";
  mode?: "efficient";
}): "ai" | "aria" {
  if (params.explicitFormat) {
    return params.explicitFormat;
  }
  if (params.mode === "efficient") {
    return "ai";
  }

  const capabilities = getBrowserProfileCapabilities(params.profile);
  if (capabilities.mode === "local-existing-session") {
    return "ai";
  }

  return params.hasPlaywright ? "ai" : "aria";
}

/** Return true when screenshots should use Playwright for the profile. */
export function shouldUsePlaywrightForScreenshot(params: {
  profile: ResolvedBrowserProfile;
  wsUrl?: string;
  ref?: string;
  element?: string;
}): boolean {
  return !params.wsUrl || Boolean(params.ref) || Boolean(params.element);
}

/** Return true when ARIA snapshots should use Playwright for the profile. */
export function shouldUsePlaywrightForAriaSnapshot(params: {
  profile: ResolvedBrowserProfile;
  wsUrl?: string;
}): boolean {
  return !params.wsUrl;
}
