import {
  activeDurableStorageKeys,
  readColdNativeActivity,
  type VolatileSessionTab,
} from "./session-tab-process-state.js";
import {
  browserSessionTabNativeIdentity,
  type BrowserSessionTabRecord,
} from "./session-tab-store.js";

type DurableTab = BrowserSessionTabRecord & {
  kind: "durable";
  storageKey: string;
};

type TrackedTab = VolatileSessionTab | DurableTab;

function trackedTabIdentity(tab: TrackedTab): string {
  return tab.kind === "durable"
    ? `durable:${tab.storageKey}`
    : `volatile:${tab.sessionKey}:${tab.targetId}\u0000${tab.baseUrl ?? ""}\u0000${tab.profile ?? ""}`;
}

export function selectStaleTrackedTabs(params: {
  tabs: TrackedTab[];
  now: number;
  idleMs?: number;
  maxTabsPerSession?: number;
  sessionFilter?: (sessionKey: string) => boolean;
}): TrackedTab[] {
  const selected = new Map<string, TrackedTab>();
  const activeBySession = new Map<string, TrackedTab[]>();
  const nativeIdentityCounts = new Map<string, number>();
  const observedNativeActivity = new Map<string, number>();
  for (const tab of params.tabs) {
    if (tab.kind !== "durable" || tab.interactionTargetKind !== "native") {
      continue;
    }
    const identity = browserSessionTabNativeIdentity(tab);
    nativeIdentityCounts.set(identity, (nativeIdentityCounts.get(identity) ?? 0) + 1);
    const observedAt = readColdNativeActivity(identity);
    if (observedAt !== undefined) {
      observedNativeActivity.set(tab.storageKey, observedAt);
    }
  }
  const effectiveLastUsedAt = (tab: TrackedTab): number =>
    tab.kind === "durable"
      ? Math.max(tab.lastUsedAt, observedNativeActivity.get(tab.storageKey) ?? 0)
      : tab.lastUsedAt;

  for (const tab of params.tabs) {
    const observedAt =
      tab.kind === "durable" ? observedNativeActivity.get(tab.storageKey) : undefined;
    const isActiveDurable =
      tab.kind === "durable" && activeDurableStorageKeys().has(tab.storageKey);
    const isUnambiguousNative =
      tab.kind === "durable" &&
      tab.interactionTargetKind === "native" &&
      nativeIdentityCounts.get(browserSessionTabNativeIdentity(tab)) === 1;
    const activitySupersedesSweep =
      tab.kind === "durable" &&
      tab.cleanupKind === "sweep" &&
      observedAt !== undefined &&
      observedAt >= (tab.cleanupRequestedAt ?? 0);
    // A prior lifecycle failure remains mandatory even when normal periodic
    // sweeps exclude that terminated session.
    if (tab.kind === "durable" && tab.cleanupAttemptToken && !activitySupersedesSweep) {
      if (tab.cleanupKind === "lifecycle" || isActiveDurable || isUnambiguousNative) {
        selected.set(trackedTabIdentity(tab), tab);
      }
      continue;
    }
    if (params.sessionFilter && !params.sessionFilter(tab.sessionKey)) {
      continue;
    }
    // Process-scoped handles and ambiguous native ids cannot prove which durable
    // row was used after restart. Lifecycle cleanup can still verify ownership,
    // but an idle sweep must wait for safe process-local activity evidence.
    if (
      tab.kind === "durable" &&
      !isActiveDurable &&
      (tab.interactionTargetKind === "opaque" || !isUnambiguousNative)
    ) {
      continue;
    }
    const active = activeBySession.get(tab.sessionKey) ?? [];
    active.push(tab);
    activeBySession.set(tab.sessionKey, active);
  }
  for (const tabs of activeBySession.values()) {
    tabs.sort(
      (left, right) =>
        effectiveLastUsedAt(left) - effectiveLastUsedAt(right) || left.trackedAt - right.trackedAt,
    );
    if (params.idleMs && params.idleMs > 0) {
      for (const tab of tabs) {
        if (params.now - effectiveLastUsedAt(tab) >= params.idleMs) {
          selected.set(trackedTabIdentity(tab), tab);
        }
      }
    }
    const remaining = tabs.filter((tab) => !selected.has(trackedTabIdentity(tab)));
    if (
      params.maxTabsPerSession &&
      params.maxTabsPerSession > 0 &&
      remaining.length > params.maxTabsPerSession
    ) {
      for (const tab of remaining.slice(0, remaining.length - params.maxTabsPerSession)) {
        selected.set(trackedTabIdentity(tab), tab);
      }
    }
  }
  return [...selected.values()];
}
