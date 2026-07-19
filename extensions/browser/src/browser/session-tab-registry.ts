/**
 * Session-owned browser tabs. Host-local durable ownership is canonical in
 * plugin SQLite; all other tabs remain process-local.
 */
import { randomUUID } from "node:crypto";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { getRuntimeConfig } from "../config/config.js";
import { resolveCdpControlPolicy } from "./cdp-reachability-policy.js";
import { closeTrackedCdpTarget, type CloseTrackedCdpTargetResult } from "./cdp.helpers.js";
import { browserCloseTabByRawTargetId } from "./client.js";
import type { BrowserTabOwnership } from "./client.types.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
import {
  clearDurableTabAliases,
  clearVolatileTabAliases,
  forgetVolatileTabAlias,
  hasDurableTabAlias,
  hasDurableTabExact,
  hasVolatileTabAlias,
  hasVolatileTabExact,
  rememberDurableTabAliases,
  rememberVolatileTabAliases,
  resolveDurableTabAlias,
  resolveDurableTabExact,
  resolveVolatileTabAlias,
  resolveVolatileTabExact,
} from "./session-tab-ephemeral-aliases.js";
import {
  activeDurableStorageKeys,
  deleteVolatileSessionTab,
  forgetColdNativeActivity,
  readColdNativeActivity,
  rememberColdNativeActivity,
  type SessionTabInteractionIdentity as InteractionIdentity,
  type VolatileSessionTab as VolatileTab,
  volatileTabsBySession,
} from "./session-tab-process-state.js";
import {
  browserSessionTabNativeIdentity,
  browserSessionTabStorageKey,
  compareBrowserSessionTabProfileAliases,
  deleteBrowserSessionTabIf,
  getBrowserSessionTabStore,
  getOptionalBrowserSessionTabStore,
  parseBrowserSessionTabRecord,
  sameBrowserSessionTabRecord,
  updateBrowserSessionTab,
  withoutBrowserSessionTabCleanup,
  type BrowserSessionTabRecord,
} from "./session-tab-store.js";
import { selectStaleTrackedTabs } from "./session-tab-sweep-selection.js";
import { selectSessionTabToUntrack } from "./session-tab-untrack-selection.js";

type SessionTabParams = {
  sessionKey?: string;
  targetId?: string;
  nativeTargetId?: string;
  baseUrl?: string;
  profile?: string;
  profileAliases?: Array<string | undefined>;
  ownership?: BrowserTabOwnership;
  aliases?: Array<string | undefined>;
};

type DurableRecord = BrowserSessionTabRecord;

type DurableTab = DurableRecord & {
  kind: "durable";
  storageKey: string;
};

type TrackedTab = VolatileTab | DurableTab;
type DurableOwnership = Extract<BrowserTabOwnership, { status: "durable" }>;
type CloseTab = (tab: {
  targetId: string;
  nativeTargetId?: string;
  baseUrl?: string;
  profile?: string;
}) => Promise<void>;
type CloseParams = {
  closeTab?: CloseTab;
  closeDurableTab?: (
    tab: DurableTab,
    options: { shouldClose: () => boolean },
  ) => Promise<CloseTrackedCdpTargetResult>;
  onWarn?: (message: string) => void;
};

type CleanupKind = "lifecycle" | "sweep";

function normalizeSessionKey(value: string): string {
  return normalizeOptionalLowercaseString(value) ?? "";
}

function normalizeProfile(value?: string): string | undefined {
  return normalizeOptionalLowercaseString(value);
}

function normalizeProfileAliases(values?: Array<string | undefined>): string[] {
  return [
    ...new Set(
      (values ?? []).map(normalizeProfile).filter((value): value is string => Boolean(value)),
    ),
  ].toSorted(compareBrowserSessionTabProfileAliases);
}

function resolveInteractionIdentity(params: SessionTabParams): InteractionIdentity | undefined {
  const sessionKey = params.sessionKey?.trim();
  const targetId = params.targetId?.trim();
  if (!sessionKey || !targetId) {
    return undefined;
  }
  const baseUrl = params.baseUrl?.trim();
  return {
    sessionKey: normalizeSessionKey(sessionKey),
    targetId,
    ...(baseUrl ? { baseUrl } : {}),
    ...(normalizeProfile(params.profile) ? { profile: normalizeProfile(params.profile) } : {}),
  };
}

function durableOwnership(params: SessionTabParams): DurableOwnership | undefined {
  return params.ownership?.status === "durable" ? params.ownership : undefined;
}

function volatileId(
  identity: Pick<InteractionIdentity, "targetId" | "baseUrl" | "profile">,
): string {
  return `${identity.targetId}\u0000${identity.baseUrl ?? ""}\u0000${identity.profile ?? ""}`;
}

function deleteInvalidRecord(key: string, onWarn?: (message: string) => void): void {
  try {
    const deleted = deleteBrowserSessionTabIf(key, (current) => {
      const record = parseBrowserSessionTabRecord(current);
      return !record || browserSessionTabStorageKey(record) !== key;
    });
    if (deleted) {
      clearDurableTabAliases(key);
      activeDurableStorageKeys().delete(key);
    }
  } catch (error) {
    onWarn?.(`failed to delete invalid browser session tab record: ${String(error)}`);
    return;
  }
  onWarn?.("deleted invalid browser session tab record");
}

function readDurableTabs(onWarn?: (message: string) => void): DurableTab[] {
  const store = getOptionalBrowserSessionTabStore();
  if (!store) {
    return [];
  }
  const tabs: DurableTab[] = [];
  for (const entry of store.entries()) {
    const record = parseBrowserSessionTabRecord(entry.value);
    if (!record || browserSessionTabStorageKey(record) !== entry.key) {
      deleteInvalidRecord(entry.key, onWarn);
      continue;
    }
    tabs.push({ ...record, kind: "durable", storageKey: entry.key });
  }
  return tabs;
}

function deleteVolatileMatching(
  identity: Pick<InteractionIdentity, "sessionKey" | "targetId" | "baseUrl" | "profile">,
): void {
  const state = volatileTabsBySession();
  const tabs = state.get(identity.sessionKey);
  if (!tabs) {
    return;
  }
  for (const [key, tab] of tabs) {
    if (
      tab.targetId === identity.targetId &&
      tab.baseUrl === identity.baseUrl &&
      tab.profile === identity.profile
    ) {
      tabs.delete(key);
      clearVolatileTabAliases(identity.sessionKey, key);
    }
  }
  if (tabs.size === 0) {
    state.delete(identity.sessionKey);
  }
}

function resolveVolatile(identity: InteractionIdentity):
  | {
      tab: VolatileTab;
      tabKey: string;
      isExact: boolean;
    }
  | undefined {
  const state = volatileTabsBySession();
  const tabs = state.get(identity.sessionKey);
  const exactKey = volatileId(identity);
  const exact = tabs?.get(exactKey);
  if (exact) {
    return { tab: exact, tabKey: exactKey, isExact: true };
  }
  const exactTarget = resolveVolatileTabExact(identity);
  if (!exactTarget && hasVolatileTabExact(identity)) {
    return undefined;
  }
  const target = exactTarget ?? resolveVolatileTabAlias(identity);
  if (!target) {
    if (!hasVolatileTabAlias(identity)) {
      forgetVolatileTabAlias(identity);
    }
    return undefined;
  }
  if (target.sessionKey !== identity.sessionKey) {
    forgetVolatileTabAlias(identity);
    return undefined;
  }
  const tab = tabs?.get(target.tabKey);
  if (!tab) {
    forgetVolatileTabAlias(identity);
    return undefined;
  }
  return { tab, tabKey: target.tabKey, isExact: Boolean(exactTarget) };
}

function upsertVolatile(
  identity: InteractionIdentity,
  aliases: Array<string | undefined>,
  profileAliases: Array<string | undefined>,
  now: number,
): void {
  const state = volatileTabsBySession();
  const tabs = state.get(identity.sessionKey) ?? new Map<string, VolatileTab>();
  const key = volatileId(identity);
  const existing = tabs.get(key);
  tabs.set(key, {
    ...identity,
    kind: "volatile",
    trackedAt: existing?.trackedAt ?? now,
    lastUsedAt: now,
  });
  state.set(identity.sessionKey, tabs);
  rememberVolatileTabAliases(identity, aliases, key, profileAliases);
}

function deleteDurableCandidate(tab: DurableTab): boolean {
  const deleted = deleteBrowserSessionTabIf(tab.storageKey, (current) => {
    const record = parseBrowserSessionTabRecord(current);
    return Boolean(record && sameBrowserSessionTabRecord(record, tab));
  });
  if (deleted) {
    clearDurableTabAliases(tab.storageKey);
    activeDurableStorageKeys().delete(tab.storageKey);
  }
  return deleted;
}

function clearDurableForVolatile(identity: InteractionIdentity): boolean {
  const mappedKey = resolveDurableTabExact(identity);
  if (!mappedKey) {
    return true;
  }
  const record = parseBrowserSessionTabRecord(getBrowserSessionTabStore().lookup(mappedKey));
  if (record) {
    return deleteDurableCandidate({ ...record, kind: "durable", storageKey: mappedKey });
  }
  clearDurableTabAliases(mappedKey);
  activeDurableStorageKeys().delete(mappedKey);
  return true;
}

/** Starts tracking a browser tab for later session cleanup. */
export function trackSessionBrowserTab(params: SessionTabParams & { now?: number }): void {
  const identity = resolveInteractionIdentity(params);
  if (!identity) {
    return;
  }
  const ownership = durableOwnership(params);
  const profileAliases = normalizeProfileAliases(params.profileAliases);
  const now = params.now ?? Date.now();
  if (identity.baseUrl) {
    upsertVolatile(identity, params.aliases ?? [], profileAliases, now);
    return;
  }
  if (!ownership) {
    if (!clearDurableForVolatile(identity)) {
      throw new Error("durable browser tab changed during non-durable transition");
    }
    upsertVolatile(identity, params.aliases ?? [], profileAliases, now);
    return;
  }
  if (!identity.profile) {
    throw new Error("durable browser tab tracking requires an explicit profile");
  }
  const profile = identity.profile;
  const storageKey = browserSessionTabStorageKey({
    sessionKey: identity.sessionKey,
    nativeTargetId: ownership.nativeTargetId,
    profileFingerprint: ownership.profileFingerprint,
    browserInstanceFingerprint: ownership.browserInstanceFingerprint,
  });
  let persistedProfileAliases: string[] = [];
  updateBrowserSessionTab(storageKey, (current) => {
    const existing = parseBrowserSessionTabRecord(current);
    persistedProfileAliases = normalizeProfileAliases([
      ...(existing?.profileAliases ?? []),
      existing?.profile,
      ...profileAliases,
    ]).filter((alias) => alias !== profile);
    return {
      version: 1,
      sessionKey: identity.sessionKey,
      nativeTargetId: ownership.nativeTargetId,
      profile,
      ...(persistedProfileAliases.length > 0 ? { profileAliases: persistedProfileAliases } : {}),
      profileFingerprint: ownership.profileFingerprint,
      browserInstanceFingerprint: ownership.browserInstanceFingerprint,
      interactionTargetKind: identity.targetId === ownership.nativeTargetId ? "native" : "opaque",
      trackedAt: existing?.trackedAt ?? now,
      lastUsedAt: now,
    };
  });
  rememberDurableTabAliases(identity, params.aliases ?? [], storageKey, persistedProfileAliases);
  activeDurableStorageKeys().add(storageKey);
  deleteVolatileMatching(identity);
}

function canonicalCandidate(
  params: SessionTabParams,
  identity: InteractionIdentity,
): DurableTab | undefined {
  const ownership = durableOwnership(params);
  if (!ownership) {
    const mappedKey = resolveDurableTabAlias(identity);
    if (mappedKey) {
      const mappedRecord = parseBrowserSessionTabRecord(
        getBrowserSessionTabStore().lookup(mappedKey),
      );
      if (mappedRecord) {
        return { ...mappedRecord, kind: "durable", storageKey: mappedKey };
      }
    }
    return undefined;
  }
  if (!identity.profile) {
    return undefined;
  }
  const key = browserSessionTabStorageKey({
    sessionKey: identity.sessionKey,
    nativeTargetId: ownership.nativeTargetId,
    profileFingerprint: ownership.profileFingerprint,
    browserInstanceFingerprint: ownership.browserInstanceFingerprint,
  });
  const record = parseBrowserSessionTabRecord(getBrowserSessionTabStore().lookup(key));
  return record ? { ...record, kind: "durable", storageKey: key } : undefined;
}

/** Updates last-used time for an existing tracked browser tab. */
export function touchSessionBrowserTab(params: SessionTabParams & { now?: number }): void {
  const identity = resolveInteractionIdentity(params);
  if (!identity) {
    return;
  }
  const now = params.now ?? Date.now();
  const volatile = resolveVolatile(identity);
  if (volatile) {
    volatileTabsBySession()
      .get(identity.sessionKey)
      ?.set(volatile.tabKey, { ...volatile.tab, lastUsedAt: now });
  }
  if (identity.baseUrl) {
    return;
  }
  if (!getOptionalBrowserSessionTabStore()) {
    return;
  }
  const candidate = canonicalCandidate(params, identity);
  if (candidate) {
    activeDurableStorageKeys().add(candidate.storageKey);
    updateBrowserSessionTab(candidate.storageKey, (current) => {
      const record = parseBrowserSessionTabRecord(current);
      if (!record || !sameBrowserSessionTabRecord(record, candidate)) {
        return undefined;
      }
      if (record.cleanupKind === "sweep") {
        return { ...withoutBrowserSessionTabCleanup(record), lastUsedAt: now };
      }
      return { ...record, lastUsedAt: now };
    });
    return;
  }
  if (identity.profile) {
    const nativeTargetId = params.nativeTargetId?.trim() || identity.targetId;
    const coldIdentity = browserSessionTabNativeIdentity({
      sessionKey: identity.sessionKey,
      profile: identity.profile,
      nativeTargetId,
    });
    if (
      readColdNativeActivity(coldIdentity) !== undefined ||
      readDurableTabs().some(
        (tab) =>
          tab.interactionTargetKind === "native" &&
          browserSessionTabNativeIdentity(tab) === coldIdentity,
      )
    ) {
      rememberColdNativeActivity(coldIdentity, now);
    }
  }
}

/** Removes a browser tab from session cleanup tracking. */
export function untrackSessionBrowserTab(params: SessionTabParams): void {
  const identity = resolveInteractionIdentity(params);
  if (!identity) {
    return;
  }
  const volatile = resolveVolatile(identity);
  if (identity.baseUrl) {
    if (volatile) {
      deleteVolatileSessionTab(identity.sessionKey, volatile.tabKey);
    }
    return;
  }
  if (!getOptionalBrowserSessionTabStore()) {
    if (volatile) {
      deleteVolatileSessionTab(identity.sessionKey, volatile.tabKey);
    }
    return;
  }
  const durable = canonicalCandidate(params, identity);
  if (durable && durableOwnership(params)) {
    deleteDurableCandidate(durable);
    return;
  }
  const selection = selectSessionTabToUntrack({
    volatileAvailable: Boolean(volatile),
    durableAvailable: Boolean(durable),
    hasVolatileCandidate: Boolean(volatile) || hasVolatileTabAlias(identity),
    hasDurableCandidate: Boolean(durable) || hasDurableTabAlias(identity),
    volatileIsExact: volatile?.isExact ?? false,
    durableIsExact: Boolean(durable && resolveDurableTabExact(identity) === durable.storageKey),
    hasVolatileExactCandidate: hasVolatileTabExact(identity),
    hasDurableExactCandidate: hasDurableTabExact(identity),
  });
  if (selection === "volatile" && volatile) {
    deleteVolatileSessionTab(identity.sessionKey, volatile.tabKey);
    return;
  }
  if (selection === "durable" && durable) {
    deleteDurableCandidate(durable);
    return;
  }
  if (selection !== "missing") {
    return;
  }
  if (identity.profile) {
    forgetColdNativeActivity(
      browserSessionTabNativeIdentity({
        sessionKey: identity.sessionKey,
        profile: identity.profile,
        nativeTargetId: params.nativeTargetId?.trim() || identity.targetId,
      }),
    );
  }
}

async function closeCurrentDurableTab(
  tab: DurableTab,
  shouldClose: () => boolean,
): Promise<CloseTrackedCdpTargetResult> {
  const cfg = getRuntimeConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const profile = resolveProfile(resolved, tab.profile);
  if (!profile?.cdpUrl) {
    return { status: "ownership-mismatch" };
  }
  const cdpControlPolicy = resolveCdpControlPolicy(profile, resolved.ssrfPolicy);
  return await closeTrackedCdpTarget({
    profileName: profile.name,
    cdpUrl: profile.cdpUrl,
    nativeTargetId: tab.nativeTargetId,
    timeoutMs: resolved.remoteCdpTimeoutMs,
    ssrfPolicy: cdpControlPolicy,
    expectedProfileFingerprint: tab.profileFingerprint,
    expectedBrowserInstanceFingerprint: tab.browserInstanceFingerprint,
    shouldClose,
  });
}

function isIgnorableTabCloseError(error: unknown): boolean {
  const message = normalizeLowercaseStringOrEmpty(String(error));
  return (
    message.includes("tab not found") ||
    message.includes("target closed") ||
    message.includes("target not found") ||
    message.includes("no such target") ||
    message.includes("no target with given id found")
  );
}

function claimCleanup(tab: DurableTab, now: number, kind: CleanupKind): DurableTab | undefined {
  const cleanupAttemptToken = randomUUID();
  // Lifecycle intent survives periodic retries; a touch may revoke only an
  // idle/cap sweep claim, never cleanup for a session that already ended.
  const cleanupKind = kind === "lifecycle" ? "lifecycle" : (tab.cleanupKind ?? kind);
  const claimed = updateBrowserSessionTab(tab.storageKey, (current) => {
    const record = parseBrowserSessionTabRecord(current);
    if (!record || !sameBrowserSessionTabRecord(record, tab)) {
      return undefined;
    }
    return {
      ...record,
      cleanupRequestedAt: now,
      cleanupAttemptToken,
      cleanupKind,
    };
  });
  return claimed
    ? { ...tab, cleanupRequestedAt: now, cleanupAttemptToken, cleanupKind }
    : undefined;
}

function matchesCleanupAttempt(
  current: BrowserSessionTabRecord | undefined,
  tab: DurableTab,
): current is BrowserSessionTabRecord {
  return Boolean(
    current &&
    current.cleanupAttemptToken === tab.cleanupAttemptToken &&
    current.cleanupRequestedAt === tab.cleanupRequestedAt &&
    current.cleanupKind === tab.cleanupKind &&
    // Lifecycle activity may advance lastUsedAt without revoking mandatory
    // cleanup. Every other field, especially the generation, must still match.
    sameBrowserSessionTabRecord({ ...current, lastUsedAt: tab.lastUsedAt }, tab),
  );
}

function ownsCleanupAttempt(tab: DurableTab): boolean {
  const current = parseBrowserSessionTabRecord(getBrowserSessionTabStore().lookup(tab.storageKey));
  return matchesCleanupAttempt(current, tab);
}

function deleteClaimedTab(tab: DurableTab, onWarn?: (message: string) => void): void {
  try {
    const deleted = deleteBrowserSessionTabIf(tab.storageKey, (current) => {
      const record = parseBrowserSessionTabRecord(current);
      return matchesCleanupAttempt(record, tab);
    });
    if (deleted) {
      clearDurableTabAliases(tab.storageKey);
      activeDurableStorageKeys().delete(tab.storageKey);
    }
  } catch (error) {
    onWarn?.(`failed to delete tracked browser tab ${tab.nativeTargetId}: ${String(error)}`);
  }
}

async function performDurableCleanup(
  candidate: DurableTab,
  params: CloseParams,
  now: number,
  cleanupKind: CleanupKind,
): Promise<number> {
  const tab = claimCleanup(candidate, now, cleanupKind);
  if (!tab) {
    return 0;
  }
  const shouldClose = () => ownsCleanupAttempt(tab);
  let outcome: CloseTrackedCdpTargetResult;
  try {
    if (params.closeDurableTab) {
      outcome = await params.closeDurableTab(tab, { shouldClose });
    } else if (params.closeTab) {
      if (!shouldClose()) {
        return 0;
      }
      await params.closeTab({
        targetId: tab.nativeTargetId,
        nativeTargetId: tab.nativeTargetId,
        profile: tab.profile,
      });
      outcome = { status: "closed" };
    } else {
      outcome = await closeCurrentDurableTab(tab, shouldClose);
    }
  } catch (error) {
    if (isIgnorableTabCloseError(error)) {
      deleteClaimedTab(tab, params.onWarn);
      return 0;
    }
    params.onWarn?.(`failed to close tracked browser tab ${tab.nativeTargetId}: ${String(error)}`);
    return 0;
  }
  if (outcome.status === "cancelled") {
    return 0;
  }
  if (outcome.status === "unavailable") {
    params.onWarn?.(`deferred tracked browser tab ${tab.nativeTargetId}: ${outcome.reason}`);
    return 0;
  }
  if (outcome.status === "ownership-mismatch") {
    params.onWarn?.(`retired tracked browser tab ${tab.nativeTargetId}: ownership mismatch`);
    deleteClaimedTab(tab, params.onWarn);
    return 0;
  }
  deleteClaimedTab(tab, params.onWarn);
  return outcome.status === "closed" ? 1 : 0;
}

async function closeDurableTab(
  candidate: DurableTab,
  params: CloseParams,
  now: number,
  cleanupKind: CleanupKind,
): Promise<number> {
  return await performDurableCleanup(candidate, params, now, cleanupKind);
}

function sameVolatileTab(left: VolatileTab, right: VolatileTab): boolean {
  return (
    volatileId(left) === volatileId(right) &&
    left.sessionKey === right.sessionKey &&
    left.trackedAt === right.trackedAt &&
    left.lastUsedAt === right.lastUsedAt
  );
}

function deleteVolatileTarget(tab: VolatileTab): void {
  const state = volatileTabsBySession();
  const targetKey = volatileId(tab);
  for (const [sessionKey, tabs] of state) {
    for (const [key, candidate] of tabs) {
      if (volatileId(candidate) === targetKey) {
        tabs.delete(key);
        clearVolatileTabAliases(sessionKey, key);
      }
    }
    if (tabs.size === 0) {
      state.delete(sessionKey);
    }
  }
}

async function performVolatileCleanup(
  candidate: VolatileTab,
  params: CloseParams,
  cleanupKind: CleanupKind,
): Promise<number> {
  const tab = resolveVolatile(candidate)?.tab;
  if (!tab) {
    return 0;
  }
  if (cleanupKind === "sweep" && !sameVolatileTab(tab, candidate)) {
    return 0;
  }
  try {
    if (params.closeTab) {
      await params.closeTab({
        targetId: tab.targetId,
        ...(tab.baseUrl ? { baseUrl: tab.baseUrl } : {}),
        ...(tab.profile ? { profile: tab.profile } : {}),
      });
    } else {
      await browserCloseTabByRawTargetId(tab.baseUrl, tab.targetId, {
        profile: tab.profile,
      });
    }
  } catch (error) {
    if (isIgnorableTabCloseError(error)) {
      deleteVolatileTarget(tab);
      return 0;
    }
    params.onWarn?.(`failed to close tracked browser tab ${tab.targetId}: ${String(error)}`);
    return 0;
  }
  deleteVolatileTarget(tab);
  return 1;
}

async function closeTrackedTabs(
  tabs: TrackedTab[],
  params: CloseParams & { cleanupKind: CleanupKind; now?: number },
): Promise<number> {
  let closed = 0;
  const now = params.now ?? Date.now();
  for (const tab of tabs) {
    closed +=
      tab.kind === "durable"
        ? await closeDurableTab(tab, params, now, params.cleanupKind)
        : await performVolatileCleanup(tab, params, params.cleanupKind);
  }
  return closed;
}

function normalizeSessionKeys(keys: Array<string | undefined>): Set<string> {
  return new Set(keys.map((key) => (key?.trim() ? normalizeSessionKey(key) : "")).filter(Boolean));
}

function volatileTabsForSessions(sessionKeys: Set<string>): VolatileTab[] {
  const result: VolatileTab[] = [];
  for (const sessionKey of sessionKeys) {
    result.push(...(volatileTabsBySession().get(sessionKey)?.values() ?? []));
  }
  return result;
}

/** Closes and untracks tabs for the supplied session keys. */
export async function closeTrackedBrowserTabsForSessions(
  params: CloseParams & { sessionKeys: Array<string | undefined> },
): Promise<number> {
  const sessionKeys = normalizeSessionKeys(params.sessionKeys);
  if (sessionKeys.size === 0) {
    return 0;
  }
  const durable = readDurableTabs(params.onWarn).filter((tab) => sessionKeys.has(tab.sessionKey));
  return await closeTrackedTabs([...durable, ...volatileTabsForSessions(sessionKeys)], {
    ...params,
    cleanupKind: "lifecycle",
  });
}

/** Closes and untracks stale, pending, or excess browser tabs. */
export async function sweepTrackedBrowserTabs(
  params: CloseParams & {
    now?: number;
    idleMs?: number;
    maxTabsPerSession?: number;
    sessionFilter?: (sessionKey: string) => boolean;
  },
): Promise<number> {
  const now = params.now ?? Date.now();
  const volatile: VolatileTab[] = [];
  for (const tabs of volatileTabsBySession().values()) {
    volatile.push(...tabs.values());
  }
  return await closeTrackedTabs(
    selectStaleTrackedTabs({
      tabs: [...readDurableTabs(params.onWarn), ...volatile],
      now,
      idleMs: params.idleMs,
      maxTabsPerSession: params.maxTabsPerSession,
      sessionFilter: params.sessionFilter,
    }),
    { ...params, now, cleanupKind: "sweep" },
  );
}
