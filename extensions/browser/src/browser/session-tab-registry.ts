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
  const sessionKeyRaw = params.sessionKey?.trim();
  const targetIdRaw = params.targetId?.trim();
  if (!sessionKeyRaw || !targetIdRaw) {
    return;
  }
  const sessionKey = normalizeSessionKey(sessionKeyRaw);
  const targetId = normalizeTargetId(targetIdRaw);
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const profile = normalizeProfile(params.profile);
  const tracked: TrackedSessionBrowserTab = {
    sessionKey,
    targetId,
    baseUrl,
    profile,
    trackedAt: Date.now(),
  };
  const trackedId = toTrackedTabId(tracked);
  let trackedForSession = trackedTabsBySession.get(sessionKey);
  if (!trackedForSession) {
    trackedForSession = new Map();
    trackedTabsBySession.set(sessionKey, trackedForSession);
  }
  trackedForSession.set(trackedId, tracked);
}

export function untrackSessionBrowserTab(params: {
  sessionKey?: string;
  targetId?: string;
  baseUrl?: string;
  profile?: string;
}): void {
  const sessionKeyRaw = params.sessionKey?.trim();
  const targetIdRaw = params.targetId?.trim();
  if (!sessionKeyRaw || !targetIdRaw) {
    return;
  }
  const sessionKey = normalizeSessionKey(sessionKeyRaw);
  const trackedForSession = trackedTabsBySession.get(sessionKey);
  if (!trackedForSession) {
    return;
  }
  const trackedId = toTrackedTabId({
    targetId: normalizeTargetId(targetIdRaw),
    baseUrl: normalizeBaseUrl(params.baseUrl),
    profile: normalizeProfile(params.profile),
  });
  trackedForSession.delete(trackedId);
  if (trackedForSession.size === 0) {
    trackedTabsBySession.delete(sessionKey);
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

export async function closeTrackedBrowserTabsForSessions(params: {
  sessionKeys: Array<string | undefined>;
  closeTab?: (tab: { targetId: string; baseUrl?: string; profile?: string }) => Promise<void>;
  onWarn?: (message: string) => void;
}): Promise<number> {
  const tabs = takeTrackedTabsForSessionKeys(params.sessionKeys);
  if (tabs.length === 0) {
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
  for (const tab of tabs) {
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
