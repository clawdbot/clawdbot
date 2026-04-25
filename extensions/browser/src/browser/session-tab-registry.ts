import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/text-runtime";
import { browserCloseTab } from "./client.js";

export type TrackedSessionBrowserTab = {
  sessionKey: string;
  targetId: string;
  baseUrl?: string;
  profile?: string;
  trackedAt: number;
  lastUsedAt: number;
};

const trackedTabsBySession = new Map<string, Map<string, TrackedSessionBrowserTab>>();

function normalizeSessionKey(raw: string): string {
  return normalizeOptionalLowercaseString(raw) ?? "";
}

function normalizeTargetId(raw: string): string {
  return raw.trim();
}

function normalizeProfile(raw?: string): string | undefined {
  return normalizeOptionalLowercaseString(raw);
}

function normalizeBaseUrl(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function toTrackedTabId(params: { targetId: string; baseUrl?: string; profile?: string }): string {
  return `${params.targetId}\u0000${params.baseUrl ?? ""}\u0000${params.profile ?? ""}`;
}

function resolveTrackedTabIdentity(params: {
  sessionKey?: string;
  targetId?: string;
  baseUrl?: string;
  profile?: string;
}): Omit<TrackedSessionBrowserTab, "trackedAt" | "lastUsedAt"> | undefined {
  const sessionKeyRaw = params.sessionKey?.trim();
  const targetIdRaw = params.targetId?.trim();
  if (!sessionKeyRaw || !targetIdRaw) {
    return undefined;
  }
  return {
    sessionKey: normalizeSessionKey(sessionKeyRaw),
    targetId: normalizeTargetId(targetIdRaw),
    baseUrl: normalizeBaseUrl(params.baseUrl),
    profile: normalizeProfile(params.profile),
  };
}

function isIgnorableCloseError(err: unknown): boolean {
  const message = normalizeLowercaseStringOrEmpty(String(err));
  return (
    message.includes("tab not found") ||
    message.includes("target closed") ||
    message.includes("target not found") ||
    message.includes("no such target")
  );
}

export function trackSessionBrowserTab(params: {
  sessionKey?: string;
  targetId?: string;
  baseUrl?: string;
  profile?: string;
}): void {
  const identity = resolveTrackedTabIdentity(params);
  if (!identity) {
    return;
  }
  const now = Date.now();
  const tracked: TrackedSessionBrowserTab = {
    ...identity,
    trackedAt: now,
    lastUsedAt: now,
  };
  const trackedId = toTrackedTabId(tracked);
  let trackedForSession = trackedTabsBySession.get(identity.sessionKey);
  if (!trackedForSession) {
    trackedForSession = new Map();
    trackedTabsBySession.set(identity.sessionKey, trackedForSession);
  }
  const existing = trackedForSession.get(trackedId);
  trackedForSession.set(trackedId, {
    ...tracked,
    trackedAt: existing?.trackedAt ?? tracked.trackedAt,
  });
}

export function touchSessionBrowserTab(params: {
  sessionKey?: string;
  targetId?: string;
  baseUrl?: string;
  profile?: string;
  now?: number;
}): void {
  const identity = resolveTrackedTabIdentity(params);
  if (!identity) {
    return;
  }
  const trackedForSession = trackedTabsBySession.get(identity.sessionKey);
  if (!trackedForSession) {
    return;
  }
  const trackedId = toTrackedTabId(identity);
  const tracked = trackedForSession.get(trackedId);
  if (!tracked) {
    return;
  }
  trackedForSession.set(trackedId, {
    ...tracked,
    lastUsedAt: params.now ?? Date.now(),
  });
}

export function untrackSessionBrowserTab(params: {
  sessionKey?: string;
  targetId?: string;
  baseUrl?: string;
  profile?: string;
}): void {
  const identity = resolveTrackedTabIdentity(params);
  if (!identity) {
    return;
  }
  const trackedForSession = trackedTabsBySession.get(identity.sessionKey);
  if (!trackedForSession) {
    return;
  }
  const trackedId = toTrackedTabId(identity);
  trackedForSession.delete(trackedId);
  if (trackedForSession.size === 0) {
    trackedTabsBySession.delete(identity.sessionKey);
  }
}

function takeTrackedTabsForSessionKeys(
  sessionKeys: Array<string | undefined>,
): TrackedSessionBrowserTab[] {
  const uniqueSessionKeys = new Set<string>();
  for (const key of sessionKeys) {
    if (!key?.trim()) {
      continue;
    }
    uniqueSessionKeys.add(normalizeSessionKey(key));
  }
  if (uniqueSessionKeys.size === 0) {
    return [];
  }
  const seenTrackedIds = new Set<string>();
  const tabs: TrackedSessionBrowserTab[] = [];
  for (const sessionKey of uniqueSessionKeys) {
    const trackedForSession = trackedTabsBySession.get(sessionKey);
    if (!trackedForSession || trackedForSession.size === 0) {
      continue;
    }
    trackedTabsBySession.delete(sessionKey);
    for (const tracked of trackedForSession.values()) {
      const trackedId = toTrackedTabId(tracked);
      if (seenTrackedIds.has(trackedId)) {
        continue;
      }
      seenTrackedIds.add(trackedId);
      tabs.push(tracked);
    }
  }
  return tabs;
}

async function closeTrackedTabs(params: {
  tabs: TrackedSessionBrowserTab[];
  closeTab?: (tab: { targetId: string; baseUrl?: string; profile?: string }) => Promise<void>;
  onWarn?: (message: string) => void;
}): Promise<number> {
  if (params.tabs.length === 0) {
    return 0;
  }
  const closeTab =
    params.closeTab ??
    (async (tab: { targetId: string; baseUrl?: string; profile?: string }) => {
      await browserCloseTab(tab.baseUrl, tab.targetId, {
        profile: tab.profile,
      });
    });
  let closed = 0;
  for (const tab of params.tabs) {
    try {
      await closeTab({
        targetId: tab.targetId,
        baseUrl: tab.baseUrl,
        profile: tab.profile,
      });
      closed += 1;
    } catch (err) {
      if (!isIgnorableCloseError(err)) {
        params.onWarn?.(`failed to close tracked browser tab ${tab.targetId}: ${String(err)}`);
      }
    }
  }
  return closed;
}

export async function closeTrackedBrowserTabsForSessions(params: {
  sessionKeys: Array<string | undefined>;
  closeTab?: (tab: { targetId: string; baseUrl?: string; profile?: string }) => Promise<void>;
  onWarn?: (message: string) => void;
}): Promise<number> {
  return await closeTrackedTabs({
    tabs: takeTrackedTabsForSessionKeys(params.sessionKeys),
    closeTab: params.closeTab,
    onWarn: params.onWarn,
  });
}

function takeStaleTrackedTabs(params: {
  now: number;
  idleMs?: number;
  maxTabsPerSession?: number;
  sessionFilter?: (sessionKey: string) => boolean;
}): TrackedSessionBrowserTab[] {
  const tabsToClose: TrackedSessionBrowserTab[] = [];
  const takenIdsBySession = new Map<string, Set<string>>();
  const mark = (sessionKey: string, trackedId: string, tracked: TrackedSessionBrowserTab): void => {
    let takenForSession = takenIdsBySession.get(sessionKey);
    if (!takenForSession) {
      takenForSession = new Set();
      takenIdsBySession.set(sessionKey, takenForSession);
    }
    if (takenForSession.has(trackedId)) {
      return;
    }
    takenForSession.add(trackedId);
    tabsToClose.push(tracked);
  };

  for (const [sessionKey, trackedForSession] of trackedTabsBySession) {
    if (params.sessionFilter && !params.sessionFilter(sessionKey)) {
      continue;
    }
    const entries = [...trackedForSession.entries()].toSorted(
      (a, b) => a[1].lastUsedAt - b[1].lastUsedAt || a[1].trackedAt - b[1].trackedAt,
    );
    if (params.idleMs && params.idleMs > 0) {
      for (const [trackedId, tracked] of entries) {
        if (params.now - tracked.lastUsedAt >= params.idleMs) {
          mark(sessionKey, trackedId, tracked);
        }
      }
    }

    const remainingEntries = entries.filter(
      ([trackedId]) => !takenIdsBySession.get(sessionKey)?.has(trackedId),
    );
    if (
      params.maxTabsPerSession &&
      params.maxTabsPerSession > 0 &&
      remainingEntries.length > params.maxTabsPerSession
    ) {
      const excess = remainingEntries.length - params.maxTabsPerSession;
      for (const [trackedId, tracked] of remainingEntries.slice(0, excess)) {
        mark(sessionKey, trackedId, tracked);
      }
    }
  }

  for (const [sessionKey, trackedIds] of takenIdsBySession) {
    const trackedForSession = trackedTabsBySession.get(sessionKey);
    if (!trackedForSession) {
      continue;
    }
    for (const trackedId of trackedIds) {
      trackedForSession.delete(trackedId);
    }
    if (trackedForSession.size === 0) {
      trackedTabsBySession.delete(sessionKey);
    }
  }
  return tabsToClose;
}

export async function sweepTrackedBrowserTabs(params: {
  now?: number;
  idleMs?: number;
  maxTabsPerSession?: number;
  sessionFilter?: (sessionKey: string) => boolean;
  closeTab?: (tab: { targetId: string; baseUrl?: string; profile?: string }) => Promise<void>;
  onWarn?: (message: string) => void;
}): Promise<number> {
  return await closeTrackedTabs({
    tabs: takeStaleTrackedTabs({
      now: params.now ?? Date.now(),
      idleMs: params.idleMs,
      maxTabsPerSession: params.maxTabsPerSession,
      sessionFilter: params.sessionFilter,
    }),
    closeTab: params.closeTab,
    onWarn: params.onWarn,
  });
}

export function __resetTrackedSessionBrowserTabsForTests(): void {
  trackedTabsBySession.clear();
}

export function __countTrackedSessionBrowserTabsForTests(sessionKey?: string): number {
  if (typeof sessionKey === "string" && sessionKey.trim()) {
    return trackedTabsBySession.get(normalizeSessionKey(sessionKey))?.size ?? 0;
  }
  let count = 0;
  for (const tracked of trackedTabsBySession.values()) {
    count += tracked.size;
  }
  return count;
}
