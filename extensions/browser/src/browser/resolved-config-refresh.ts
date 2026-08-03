/**
 * Runtime config refresh helpers for Browser profiles that can be hot-reloaded
 * without restarting the whole Browser plugin server.
 */
import { loadBrowserConfigForRuntimeRefresh } from "./config-refresh-source.js";
import { resolveBrowserConfig, resolveProfile, type ResolvedBrowserProfile } from "./config.js";
import { beginProfileTransition, getProfileLifecycle } from "./server-context.lifecycle.js";
import type { BrowserServerState, ProfileRuntimeState } from "./server-context.types.js";

function changedProfileInvariants(
  current: ResolvedBrowserProfile,
  next: ResolvedBrowserProfile,
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
  if (
    currentUsesLocalManagedLaunch &&
    nextUsesLocalManagedLaunch &&
    current.headless !== next.headless
  ) {
    changed.push("headless");
  }
  if (
    currentUsesLocalManagedLaunch &&
    nextUsesLocalManagedLaunch &&
    current.executablePath !== next.executablePath
  ) {
    changed.push("executablePath");
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
  if (
    current.mcpArgs?.length !== next.mcpArgs?.length ||
    current.mcpArgs?.some((arg, index) => arg !== next.mcpArgs?.[index])
  ) {
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
  current.resolved = {
    ...freshResolved,
    // Keep the runtime evaluate gate stable across request-time profile refreshes.
    // Security-sensitive behavior should only change via full runtime config reload,
    // not as a side effect of resolving profiles/tabs during a request.
    evaluateEnabled: current.resolved.evaluateEnabled,
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
    const nextProfile = resolveProfile(freshResolved, name);
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
      const changed = changedProfileInvariants(runtime.profile, nextProfile);
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

/** Resolves a profile after an optional config reload. */
export function resolveBrowserProfileWithHotReload(params: {
  current: BrowserServerState;
  refreshConfigFromDisk: boolean;
  name: string;
}): ResolvedBrowserProfile | null {
  refreshResolvedBrowserConfigFromDisk({
    current: params.current,
    refreshConfigFromDisk: params.refreshConfigFromDisk,
  });
  return resolveProfile(params.current.resolved, params.name);
}
