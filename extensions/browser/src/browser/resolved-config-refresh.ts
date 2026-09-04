/**
 * Runtime config refresh helpers for Browser profiles that can be hot-reloaded
 * without restarting the whole Browser plugin server.
 */
import { isDeepStrictEqual } from "node:util";
import { loadBrowserConfigForRuntimeRefresh } from "./config-refresh-source.js";
import { resolveBrowserConfig, resolveProfile, type ResolvedBrowserProfile } from "./config.js";
import { beginProfileTransition, getProfileLifecycle } from "./server-context.lifecycle.js";
import type { BrowserServerState, ProfileRuntimeState } from "./server-context.types.js";

function changedProfileInvariants(
  current: ResolvedBrowserProfile,
  next: ResolvedBrowserProfile,
  previousConfig: BrowserServerState["resolved"],
  nextConfig: BrowserServerState["resolved"],
): string[] {
  const changed: string[] = [];
  const currentUsesLocalManagedLaunch =
    current.driver === "openclaw" && !current.attachOnly && current.cdpIsLoopback;
  const nextUsesLocalManagedLaunch =
    next.driver === "openclaw" && !next.attachOnly && next.cdpIsLoopback;
  if (current.cdpUrl !== next.cdpUrl) {
    changed.push("cdpUrl");
  }
  if (current.cdpPort !== next.cdpPort) {
    changed.push("cdpPort");
  }
  if (current.driver !== next.driver) {
    changed.push("driver");
  }
  if (currentUsesLocalManagedLaunch && nextUsesLocalManagedLaunch) {
    if (current.headless !== next.headless) {
      changed.push("headless");
    }
    if (current.executablePath !== next.executablePath) {
      changed.push("executablePath");
    }
    if (previousConfig.noSandbox !== nextConfig.noSandbox) {
      changed.push("noSandbox");
    }
    if (!isDeepStrictEqual(previousConfig.extraArgs, nextConfig.extraArgs)) {
      changed.push("extraArgs");
    }
  }
  if (current.attachOnly !== next.attachOnly) {
    changed.push("attachOnly");
  }
  if (current.cdpIsLoopback !== next.cdpIsLoopback) {
    changed.push("cdpIsLoopback");
  }
  if ((current.userDataDir ?? "") !== (next.userDataDir ?? "")) {
    changed.push("userDataDir");
  }
  if ((current.mcpCommand ?? "") !== (next.mcpCommand ?? "")) {
    changed.push("mcpCommand");
  }
  if (!isDeepStrictEqual(current.mcpArgs, next.mcpArgs)) {
    changed.push("mcpArgs");
  }
  return changed;
}

function queueRemovedProfileCleanup(params: {
  current: BrowserServerState;
  name: string;
  runtime: ProfileRuntimeState;
  initial: boolean;
}) {
  const actor = getProfileLifecycle(params.runtime);
  if (!params.initial && (!actor.blockedReason || actor.transitionReason)) {
    return;
  }
  params.runtime.lastTargetId = null;
  void beginProfileTransition({
    state: params.current,
    runtime: params.runtime,
    reason: params.initial ? "profile removed from config" : "profile removal cleanup retry",
    terminal: "config-removed",
    advanceConfigRevision: params.initial,
    closeRelay: params.runtime.profile.driver === "extension",
    exposeReason: true,
  })
    .then(() => {
      if (params.current.profiles.get(params.name) === params.runtime) {
        params.current.profiles.delete(params.name);
      }
    })
    .catch(() => {});
}

function applyResolvedConfig(
  current: BrowserServerState,
  freshResolved: BrowserServerState["resolved"],
) {
  const previousResolved = current.resolved;
  const extensionRelayInternalTokens: Record<string, string> = {};
  for (const [name, relay] of current.extensionRelays ?? []) {
    const runtime = current.profiles.get(name);
    const lifecycle = runtime && getProfileLifecycle(runtime);
    const profile = resolveProfile(freshResolved, name);
    if (
      runtime?.profile.driver === "extension" &&
      !lifecycle?.terminal &&
      !lifecycle?.transitionReason &&
      !lifecycle?.cleanupRelays.has(relay) &&
      profile?.driver === "extension" &&
      profile.cdpPort === relay.port &&
      relay.ownership !== "borrowed"
    ) {
      extensionRelayInternalTokens[name] = relay.internalToken;
    }
  }
  current.resolved = {
    ...freshResolved,
    // Admission, security and relay authentication belong to the running
    // service; a request must not adopt changes that are waiting for its restart.
    enabled: previousResolved.enabled,
    evaluateEnabled: previousResolved.evaluateEnabled,
    ssrfPolicy: previousResolved.ssrfPolicy,
    extensionRelay: previousResolved.extensionRelay,
    // Only an exact live relay owns its process-local CDP credential; stale
    // config snapshots must never resurrect closed or replaced credentials.
    extensionRelayInternalTokens,
    // Config refresh must not erase the lifecycle's key while a relay is starting.
    extensionRelayToken: previousResolved.extensionRelayToken,
  };
  for (const [name, runtime] of current.profiles) {
    const actor = getProfileLifecycle(runtime);
    if (actor.terminal === "config-removed") {
      queueRemovedProfileCleanup({ current, name, runtime, initial: false });
      continue;
    }
    if (actor.terminal) {
      continue;
    }
    const nextProfile = resolveProfile(current.resolved, name);
    if (nextProfile) {
      if (actor.blockedReason && !actor.transitionReason) {
        void beginProfileTransition({
          state: current,
          runtime,
          reason: "profile invariant cleanup retry",
          captureProfileResources: false,
          exposeReason: true,
        }).catch(() => {});
        continue;
      }
      const changed = changedProfileInvariants(
        runtime.profile,
        nextProfile,
        previousResolved,
        freshResolved,
      );
      if (changed.length > 0) {
        const previousProfile = runtime.profile;
        const reason = `profile invariants changed: ${changed.join(", ")}`;
        void beginProfileTransition({
          state: current,
          runtime,
          reason,
          advanceConfigRevision: true,
          closeRelay: previousProfile.driver === "extension",
          exposeReason: true,
        }).catch(() => {});
        runtime.lastTargetId = null;
      }
      runtime.profile = nextProfile;
      continue;
    }
    queueRemovedProfileCleanup({ current, name, runtime, initial: true });
  }
}

/** Refreshes the Browser runtime's resolved config from disk when hot reload is enabled. */
export function refreshResolvedBrowserConfigFromDisk(params: {
  current: BrowserServerState;
  refreshConfigFromDisk: boolean;
}) {
  if (!params.refreshConfigFromDisk) {
    return;
  }

  // Route-level refresh should use the shared runtime config. Config mutations
  // refresh that snapshot and decide whether the wider runtime should restart.
  const cfg = loadBrowserConfigForRuntimeRefresh();
  const freshResolved = resolveBrowserConfig(cfg.browser, cfg);
  applyResolvedConfig(params.current, freshResolved);
}
