import {
  resolveCdpControlPolicy,
  resolveCdpReachabilityPolicy,
} from "./cdp-reachability-policy.js";
import { usesFastLoopbackCdpProbeClass } from "./cdp-timeouts.js";
import { redactCdpUrl } from "./cdp.helpers.js";
import { listChromeMcpTabs } from "./chrome-mcp.js";
import { isChromeReachable, resolveOpenClawUserDataDir } from "./chrome.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { resolveProfile } from "./config.js";
import { BrowserProfileNotFoundError, toBrowserErrorResponse } from "./errors.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import {
  refreshResolvedBrowserConfigFromDisk,
  resolveBrowserProfileWithHotReload,
} from "./resolved-config-refresh.js";
import { createProfileAvailability } from "./server-context.availability.js";
import { createProfileResetOps } from "./server-context.reset.js";
import { createProfileSelectionOps } from "./server-context.selection.js";
import { createProfileTabOps } from "./server-context.tab-ops.js";
import type {
  BrowserServerState,
  BrowserRouteContext,
  BrowserTab,
  ContextOptions,
  ProfileContext,
  ProfileRuntimeState,
  ProfileStatus,
} from "./server-context.types.js";

export type {
  BrowserRouteContext,
  BrowserServerState,
  BrowserTab,
  ProfileContext,
  ProfileRuntimeState,
  ProfileStatus,
} from "./server-context.types.js";

export function listKnownProfileNames(state: BrowserServerState): string[] {
  const names = new Set(Object.keys(state.resolved.profiles));
  for (const name of state.profiles.keys()) {
    names.add(name);
  }
  return [...names];
}

/**
 * Create a profile-scoped context for browser operations.
 */
function createProfileContext(
  opts: ContextOptions,
  profile: ResolvedBrowserProfile,
): ProfileContext {
  const state = () => {
    const current = opts.getState();
    if (!current) {
      throw new Error("Browser server not started");
    }
    return current;
  };

  const getProfileState = (): ProfileRuntimeState => {
    const current = state();
    let profileState = current.profiles.get(profile.name);
    if (!profileState) {
      profileState = { profile, running: null, lastTargetId: null, reconcile: null };
      current.profiles.set(profile.name, profileState);
    }
    return profileState;
  };

  const setProfileRunning = (running: ProfileRuntimeState["running"]) => {
    const profileState = getProfileState();
    profileState.running = running;
  };

  const { listTabs, openTab, labelTab } = createProfileTabOps({
    profile,
    state,
    getProfileState,
  });

  const {
    ensureBrowserAvailable,
    isHttpReachable,
    isTransportAvailable,
    isReachable,
    stopRunningBrowser,
  } = createProfileAvailability({
    opts,
    profile,
    state,
    getProfileState,
    setProfileRunning,
  });

  const { ensureTabAvailable, focusTab, closeTab } = createProfileSelectionOps({
    profile,
    getProfileState,
    getCdpControlPolicy: () => resolveCdpControlPolicy(profile, state().resolved.ssrfPolicy),
    ensureBrowserAvailable,
    listTabs,
    openTab,
  });

  const { resetProfile } = createProfileResetOps({
    profile,
    getProfileState,
    stopRunningBrowser,
    isHttpReachable,
    resolveOpenClawUserDataDir,
  });

  return {
    profile,
    ensureBrowserAvailable,
    ensureTabAvailable,
    isHttpReachable,
    isTransportAvailable,
    isReachable,
    listTabs,
    openTab,
    labelTab,
    focusTab,
    closeTab,
    stopRunningBrowser,
    resetProfile,
  };
}

export function createBrowserRouteContext(opts: ContextOptions): BrowserRouteContext {
  const refreshConfigFromDisk = opts.refreshConfigFromDisk === true;

  const state = () => {
    const current = opts.getState();
    if (!current) {
      throw new Error("Browser server not started");
    }
    return current;
  };

  const forProfile = (profileName?: string): ProfileContext => {
    const current = state();
    const name = profileName ?? current.resolved.defaultProfile;
    const profile = resolveBrowserProfileWithHotReload({
      current,
      refreshConfigFromDisk,
      name,
    });

    if (!profile) {
      const available = Object.keys(current.resolved.profiles).join(", ");
      throw new BrowserProfileNotFoundError(
        `Profile "${name}" not found. Available profiles: ${available || "(none)"}`,
      );
    }
    return createProfileContext(opts, profile);
  };

  const listProfiles = async (): Promise<ProfileStatus[]> => {
    const current = state();
    refreshResolvedBrowserConfigFromDisk({
      current,
      refreshConfigFromDisk,
      mode: "cached",
    });
    const result: ProfileStatus[] = [];

    for (const name of listKnownProfileNames(current)) {
      const profileState = current.profiles.get(name);
      const profile = resolveProfile(current.resolved, name) ?? profileState?.profile;
      if (!profile) {
        continue;
      }
      const capabilities = getBrowserProfileCapabilities(profile);

      let tabCount = 0;
      let running = false;
      const profileCtx = createProfileContext(opts, profile);

      if (capabilities.usesChromeMcp) {
        try {
          running = await profileCtx.isTransportAvailable(300);
          if (running) {
            const tabs = await listChromeMcpTabs(profile.name, profile, {
              ephemeral: true,
            }).catch(() => [] as BrowserTab[]);
            tabCount = tabs.filter((t) => t.type === "page").length;
          }
        } catch {
          // Chrome MCP not available
        }
      } else if (profileState?.running) {
        running = true;
        try {
          const tabs = await profileCtx.listTabs();
          tabCount = tabs.filter((t) => t.type === "page").length;
        } catch {
          // Browser might not be responsive
        }
      } else {
        // Check if something is listening on the port
        try {
          const probeTimeoutMs = usesFastLoopbackCdpProbeClass({
            profileIsLoopback: profile.cdpIsLoopback,
            attachOnly: profile.attachOnly,
          })
            ? 200
            : current.resolved.remoteCdpTimeoutMs;
          const reachable = await isChromeReachable(
            profile.cdpUrl,
            probeTimeoutMs,
            resolveCdpReachabilityPolicy(profile, current.resolved.ssrfPolicy),
          );
          if (reachable) {
            running = true;
            const tabs = await profileCtx.listTabs().catch(() => []);
            tabCount = tabs.filter((t) => t.type === "page").length;
          }
        } catch {
          // Not reachable
        }
      }

      result.push({
        name,
        transport: capabilities.usesChromeMcp ? "chrome-mcp" : "cdp",
        cdpPort: capabilities.usesChromeMcp ? null : profile.cdpPort,
        cdpUrl: capabilities.usesChromeMcp ? null : (redactCdpUrl(profile.cdpUrl) ?? null),
        color: profile.color,
        driver: profile.driver,
        running,
        tabCount,
        isDefault: name === current.resolved.defaultProfile,
        isRemote: !profile.cdpIsLoopback,
        missingFromConfig: !(name in current.resolved.profiles) || undefined,
        reconcileReason: profileState?.reconcile?.reason ?? null,
      });
    }

    return result;
  };

  // Create default profile context for backward compatibility
  const getDefaultContext = () => forProfile();

  const mapTabError = (err: unknown) => {
    const browserMapped = toBrowserErrorResponse(err);
    if (browserMapped) {
      return browserMapped;
    }
    return null;
  };

  return {
    state,
    forProfile,
    listProfiles,
    // Legacy methods delegate to default profile
    ensureBrowserAvailable: () => getDefaultContext().ensureBrowserAvailable(),
    ensureTabAvailable: (targetId) => getDefaultContext().ensureTabAvailable(targetId),
    isHttpReachable: (timeoutMs) => getDefaultContext().isHttpReachable(timeoutMs),
    isTransportAvailable: (timeoutMs) => getDefaultContext().isTransportAvailable(timeoutMs),
    isReachable: (timeoutMs, options) => getDefaultContext().isReachable(timeoutMs, options),
    listTabs: () => getDefaultContext().listTabs(),
    openTab: (url, opts) => getDefaultContext().openTab(url, opts),
    labelTab: (targetId, label) => getDefaultContext().labelTab(targetId, label),
    focusTab: (targetId) => getDefaultContext().focusTab(targetId),
    closeTab: (targetId) => getDefaultContext().closeTab(targetId),
    stopRunningBrowser: () => getDefaultContext().stopRunningBrowser(),
    resetProfile: () => getDefaultContext().resetProfile(),
    mapTabError,
  };
}
