import { loadBrowserConfigForRuntimeRefresh } from "./config-refresh-source.js";
import { resolveBrowserConfig, resolveProfile, type ResolvedBrowserProfile } from "./config.js";
import type { BrowserServerState } from "./server-context.types.js";

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
  return changed;
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
    const nextProfile = resolveProfile(freshResolved, name);
    if (nextProfile) {
      const changed = changedProfileInvariants(runtime.profile, nextProfile);
      if (changed.length > 0) {
        runtime.reconcile = {
          previousProfile: runtime.profile,
          reason: `profile invariants changed: ${changed.join(", ")}`,
        };
        runtime.lastTargetId = null;
      }
      runtime.profile = nextProfile;
      continue;
    }
    runtime.reconcile = {
      previousProfile: runtime.profile,
      reason: "profile removed from config",
    };
    runtime.lastTargetId = null;
    if (!runtime.running) {
      current.profiles.delete(name);
    }
  }
}

export function refreshResolvedBrowserConfigFromDisk(params: {
  current: BrowserServerState;
  refreshConfigFromDisk: boolean;
  mode: "cached" | "fresh";
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

export function resolveBrowserProfileWithHotReload(params: {
  current: BrowserServerState;
  refreshConfigFromDisk: boolean;
  name: string;
}): ResolvedBrowserProfile | null {
  refreshResolvedBrowserConfigFromDisk({
    current: params.current,
    refreshConfigFromDisk: params.refreshConfigFromDisk,
    mode: "cached",
  });
  let profile = resolveProfile(params.current.resolved, params.name);
  if (profile) {
    return profile;
  }

  // Hot-reload: profile missing; retry with a fresh disk read without flushing the global cache.
  refreshResolvedBrowserConfigFromDisk({
    current: params.current,
    refreshConfigFromDisk: params.refreshConfigFromDisk,
    mode: "fresh",
  });
  profile = resolveProfile(params.current.resolved, params.name);
  return profile;
}
