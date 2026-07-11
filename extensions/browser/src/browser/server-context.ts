/**
 * Browser route context factory that wires profile-scoped runtime operations for
 * the Browser control server.
 */
import {
  resolveCdpControlPolicy,
  resolveCdpReachabilityPolicy,
} from "./cdp-reachability-policy.js";
import { usesFastLoopbackCdpProbeClass } from "./cdp-timeouts.js";
import { redactCdpUrl } from "./cdp.helpers.js";
import { countChromeMcpTabs } from "./chrome-mcp.js";
import { isChromeReachable, resolveOpenClawUserDataDir } from "./chrome.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { resolveProfile } from "./config.js";
import {
  BrowserProfileNotFoundError,
  BrowserProfileUnavailableError,
  toBrowserErrorResponse,
} from "./errors.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import {
  refreshResolvedBrowserConfigFromDisk,
  resolveBrowserProfileWithHotReload,
} from "./resolved-config-refresh.js";
import { createProfileAvailability } from "./server-context.availability.js";
import {
  getProfileLifecycle,
  getOrCreateProfileRuntime,
  isBrowserRuntimeRunning,
  withProfileOperationLease,
} from "./server-context.lifecycle.js";
import { createProfileResetOps } from "./server-context.reset.js";
import { createProfileSelectionOps } from "./server-context.selection.js";
import { createProfileTabOps } from "./server-context.tab-ops.js";
import type {
  BrowserServerState,
  BrowserRouteContext,
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

/** Lists configured and runtime-known Browser profile names without duplicates. */
export function listKnownProfileNames(state: BrowserServerState): string[] {
  const names = new Set(Object.keys(state.resolved.profiles));
  for (const name of state.profiles.keys()) {
    names.add(name);
  }
  return [...names];
}

type ProfileOperationRunner = <T>(
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal, runtime: ProfileRuntimeState) => Promise<T>,
  options?: { commit?: (result: T) => void | Promise<void> },
) => Promise<T>;

const profileOperationRunners = new WeakMap<ProfileContext, ProfileOperationRunner>();

/** Internal actor lease entrypoint; not part of the public Browser runtime API. */
export function runProfileContextOperation<T>(
  profileCtx: ProfileContext,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal, runtime: ProfileRuntimeState) => Promise<T>,
  options?: { commit?: (result: T) => void | Promise<void> },
): Promise<T> {
  const runner = profileOperationRunners.get(profileCtx);
  if (!runner) {
    throw new BrowserProfileUnavailableError("Browser profile context is no longer active.");
  }
  return runner(signal, run, options);
}

/** Preserve custom route contexts while leasing contexts created by this runtime. */
export function withProfileContextOperation<T>(
  profileCtx: ProfileContext,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const runner = profileOperationRunners.get(profileCtx);
  if (!runner) {
    const directSignal = signal ?? new AbortController().signal;
    return run(directSignal);
  }
  return runner(signal, async (leasedSignal) => await run(leasedSignal));
}

/**
 * Create a profile-scoped context for browser operations.
 */
function createProfileContext(
  opts: ContextOptions,
  runtimeState: BrowserServerState,
  profileState: ProfileRuntimeState,
  profile: ResolvedBrowserProfile,
): ProfileContext {
  const state = () => {
    const current = opts.getState();
    if (current !== runtimeState || !isBrowserRuntimeRunning(runtimeState)) {
      throw new BrowserProfileUnavailableError("Browser runtime changed or is stopping.");
    }
    return runtimeState;
  };

  const configRevision = getProfileLifecycle(profileState).configRevision;

  const rawTabOps = createProfileTabOps({
    profile,
    state,
    runtime: profileState,
  });

  const rawAvailability = createProfileAvailability({
    opts,
    profile,
    state,
    runtime: profileState,
    configRevision,
  });

  const rawSelection = createProfileSelectionOps({
    profile,
    runtime: profileState,
    getCdpControlPolicy: () => resolveCdpControlPolicy(profile, state().resolved.ssrfPolicy),
    ensureBrowserAvailable: rawAvailability.ensureBrowserAvailable,
    listTabs: rawTabOps.listTabs,
    openTab: rawTabOps.openTab,
  });

  const rawReset = createProfileResetOps({
    profile,
    state,
    runtime: profileState,
    configRevision,
    resolveOpenClawUserDataDir,
  });

  const withLease = async <T>(
    callerSignal: AbortSignal | undefined,
    run: (signal: AbortSignal, runtime: ProfileRuntimeState) => Promise<T>,
    options?: { commit?: (result: T) => void | Promise<void> },
  ): Promise<T> =>
    await withProfileOperationLease({
      state: state(),
      runtime: profileState,
      configRevision,
      signal: callerSignal,
      run: async (lifecycleSignal) => await run(lifecycleSignal, profileState),
      commit: options?.commit,
    });

  const { ensureBrowserAvailable, stopRunningBrowser } = rawAvailability;

  const context: ProfileContext = {
    profile,
    ensureBrowserAvailable,
    ensureTabAvailable: async (targetId, options) => {
      await ensureBrowserAvailable({ signal: options?.signal });
      return await withLease(
        options?.signal,
        async (signal) =>
          await rawSelection.ensureTabAvailable(targetId, { ...options, signal }, true),
      );
    },
    isHttpReachable: async (timeoutMs) =>
      await withLease(
        undefined,
        async (signal) => await rawAvailability.isHttpReachable(timeoutMs, signal),
      ),
    isTransportAvailable: async (timeoutMs) =>
      await withLease(
        undefined,
        async (signal) => await rawAvailability.isTransportAvailable(timeoutMs, signal),
      ),
    isReachable: async (timeoutMs, options) =>
      await withLease(
        options?.signal,
        async (signal) => await rawAvailability.isReachable(timeoutMs, { ...options, signal }),
      ),
    listTabs: async (options) =>
      await withLease(
        options?.signal,
        async (signal) => await rawTabOps.listTabs({ ...options, signal }),
      ),
    openTab: async (url, options) =>
      await withLease(
        options?.signal,
        async (signal) => await rawTabOps.openTab(url, { ...options, signal }),
      ),
    labelTab: async (targetId, label) =>
      await withLease(
        undefined,
        async (signal) => await rawTabOps.labelTab(targetId, label, { signal }),
      ),
    focusTab: async (targetId, options) =>
      await withLease(
        options?.signal,
        async (signal) => await rawSelection.focusTab(targetId, { ...options, signal }),
      ),
    closeTab: async (targetId, options) =>
      await withLease(
        options?.signal,
        async (signal) => await rawSelection.closeTab(targetId, { ...options, signal }),
      ),
    stopRunningBrowser,
    resetProfile: rawReset.resetProfile,
  };
  profileOperationRunners.set(context, withLease);
  return context;
}

/** Creates the Browser route context used by control-server route handlers. */
export function createBrowserRouteContext(opts: ContextOptions): BrowserRouteContext {
  const refreshConfigFromDisk = opts.refreshConfigFromDisk === true;

  const state = () => {
    const current = opts.getState();
    if (!current) {
      throw new BrowserProfileUnavailableError("Browser server not started.");
    }
    if (!isBrowserRuntimeRunning(current)) {
      throw new BrowserProfileUnavailableError("Browser runtime is stopping.");
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
    const profileState = getOrCreateProfileRuntime(current, profile);
    return createProfileContext(opts, current, profileState, profile);
  };

  const listProfiles = async (): Promise<ProfileStatus[]> => {
    const current = state();
    refreshResolvedBrowserConfigFromDisk({
      current,
      refreshConfigFromDisk,
    });
    const result: ProfileStatus[] = [];

    for (const name of listKnownProfileNames(current)) {
      let profileState = current.profiles.get(name);
      const profile = resolveProfile(current.resolved, name) ?? profileState?.profile;
      if (!profile) {
        continue;
      }
      profileState ??= getOrCreateProfileRuntime(current, profile);
      let statusProfile = profile;
      let unavailableReason: string | null = null;
      let running = false;
      let tabCount = 0;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        statusProfile = profileState.profile;
        const profileCtx = createProfileContext(opts, current, profileState, statusProfile);
        try {
          const snapshot = await runProfileContextOperation(
            profileCtx,
            undefined,
            async (signal, runtime) => {
              const activeProfile = runtime.profile;
              const capabilities = getBrowserProfileCapabilities(activeProfile);
              let activeRunning: boolean;
              let activeTabCount = 0;

              if (capabilities.usesChromeMcp) {
                try {
                  activeRunning = await profileCtx.isTransportAvailable(300);
                  if (activeRunning) {
                    activeTabCount = await countChromeMcpTabs(activeProfile.name, activeProfile, {
                      ephemeral: true,
                      signal,
                    }).catch(() => 0);
                  }
                } catch {
                  activeRunning = false;
                }
              } else if (runtime.running) {
                activeRunning = true;
                try {
                  const tabs = await profileCtx.listTabs({ signal });
                  activeTabCount = tabs.filter((tab) => tab.type === "page").length;
                } catch {
                  // Browser might not be responsive.
                }
              } else {
                try {
                  const probeTimeoutMs = usesFastLoopbackCdpProbeClass({
                    profileIsLoopback: activeProfile.cdpIsLoopback,
                    attachOnly: activeProfile.attachOnly,
                  })
                    ? 200
                    : current.resolved.remoteCdpTimeoutMs;
                  activeRunning = await isChromeReachable(
                    activeProfile.cdpUrl,
                    probeTimeoutMs,
                    resolveCdpReachabilityPolicy(activeProfile, current.resolved.ssrfPolicy),
                  );
                  if (activeRunning) {
                    const tabs = await profileCtx.listTabs({ signal }).catch(() => []);
                    activeTabCount = tabs.filter((tab) => tab.type === "page").length;
                  }
                } catch {
                  activeRunning = false;
                }
              }
              signal.throwIfAborted();
              return { profile: activeProfile, running: activeRunning, tabCount: activeTabCount };
            },
          );
          statusProfile = snapshot.profile;
          running = snapshot.running;
          tabCount = snapshot.tabCount;
          break;
        } catch (err) {
          if (attempt === 0) {
            continue;
          }
          statusProfile = profileState.profile;
          const actor = getProfileLifecycle(profileState);
          unavailableReason = actor.blockedReason ?? actor.transitionReason ?? actor.terminal;
          if (!unavailableReason && !toBrowserErrorResponse(err)) {
            throw err;
          }
          running = Boolean(profileState.running);
          tabCount = 0;
        }
      }

      const capabilities = getBrowserProfileCapabilities(statusProfile);
      result.push({
        name,
        transport: capabilities.usesChromeMcp
          ? "chrome-mcp"
          : capabilities.mode === "local-extension"
            ? "extension"
            : "cdp",
        cdpPort: capabilities.usesChromeMcp ? null : statusProfile.cdpPort,
        cdpUrl: statusProfile.cdpUrl ? (redactCdpUrl(statusProfile.cdpUrl) ?? null) : null,
        color: statusProfile.color,
        driver: statusProfile.driver,
        running,
        tabCount,
        isDefault: name === current.resolved.defaultProfile,
        isRemote: !statusProfile.cdpIsLoopback,
        missingFromConfig: !(name in current.resolved.profiles) || undefined,
        reconcileReason: unavailableReason,
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
    ensureBrowserAvailable: (options) => getDefaultContext().ensureBrowserAvailable(options),
    ensureTabAvailable: (targetId, options) =>
      getDefaultContext().ensureTabAvailable(targetId, options),
    isHttpReachable: (timeoutMs) => getDefaultContext().isHttpReachable(timeoutMs),
    isTransportAvailable: (timeoutMs) => getDefaultContext().isTransportAvailable(timeoutMs),
    isReachable: (timeoutMs, options) => getDefaultContext().isReachable(timeoutMs, options),
    listTabs: () => getDefaultContext().listTabs(),
    openTab: (url, optsLocal) => getDefaultContext().openTab(url, optsLocal),
    labelTab: (targetId, label) => getDefaultContext().labelTab(targetId, label),
    focusTab: (targetId, options) => getDefaultContext().focusTab(targetId, options),
    closeTab: (targetId, options) => getDefaultContext().closeTab(targetId, options),
    stopRunningBrowser: () => getDefaultContext().stopRunningBrowser(),
    resetProfile: () => getDefaultContext().resetProfile(),
    mapTabError,
  };
}
