/**
 * Session-owned browser tabs. Host-local durable ownership is canonical in
 * plugin SQLite; all other tabs remain process-local.
 */
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getRuntimeConfig } from "../config/config.js";
import type { BrowserStewardRuntimeDecision } from "./browser-steward-runtime-guard.js";
import { resolveCdpControlPolicy } from "./cdp-reachability-policy.js";
import { closeTrackedCdpTarget, type CloseTrackedCdpTargetResult } from "./cdp.helpers.js";
import { browserCloseTabByRawTargetId } from "./client.js";
import type { BrowserTabOwnership } from "./client.types.js";
import { resolveBrowserConfig, resolveProfile, type ResolvedBrowserConfig } from "./config.js";
import { BROWSER_TAB_UNREACHABLE_RETIRE_MS } from "./constants.js";
import {
  type CleanupKind,
  claimCleanup,
  deleteClaimedTab,
  isIgnorableTabCloseError,
  ownsCleanupAttempt,
} from "./session-tab-cleanup-claim.js";
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
  normalizeBrowserSessionKey,
  readColdNativeActivity,
  rememberColdNativeActivity,
  sameVolatileSessionTab,
  type SessionTabInteractionIdentity as InteractionIdentity,
  type VolatileSessionTab as VolatileTab,
  volatileSessionTabTargetKey,
  volatileTabCleanupByTarget,
  volatileTabsBySession,
} from "./session-tab-process-state.js";
import type { BrowserSessionTabRoute } from "./session-tab-route.js";
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
import {
  selectStaleTrackedTabs,
  selectTrackedTabsForSessions,
} from "./session-tab-sweep-selection.js";
import { selectSessionTabToUntrack } from "./session-tab-untrack-selection.js";

type SessionTabParams = {
  sessionKey?: string;
  targetId?: string;
  nativeTargetId?: string;
  route?: BrowserSessionTabRoute;
  profile?: string;
  profileAliases?: Array<string | undefined>;
  ownership?: BrowserTabOwnership;
  aliases?: Array<string | undefined>;
  browserStewardRuntimeDecision?: BrowserStewardRuntimeDecision;
};

type DurableRecord = BrowserSessionTabRecord;

type DurableTab = DurableRecord & {
  kind: "durable";
  storageKey: string;
};

type TrackedTab = VolatileTab | DurableTab;
type DurableOwnership = Extract<BrowserTabOwnership, { status: "durable" }>;
type DurableCleanupResult =
  | CloseTrackedCdpTargetResult
  | { status: "unavailable"; reason: "extension-relay-unavailable" };
type CloseTab = (tab: {
  targetId: string;
  nativeTargetId?: string;
  baseUrl?: string;
  route?: BrowserSessionTabRoute;
  profile?: string;
}) => Promise<void>;
type CloseParams = {
  closeTab?: CloseTab;
  closeDurableTab?: (
    tab: DurableTab,
    options: { shouldClose: () => boolean },
  ) => Promise<CloseTrackedCdpTargetResult>;
  getResolvedBrowserConfig?: () => ResolvedBrowserConfig | null;
  onWarn?: (message: string) => void;
};

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
  return {
    sessionKey: normalizeBrowserSessionKey(sessionKey) ?? "",
    targetId,
    route: params.route ?? { kind: "browser-control" },
    ...(normalizeProfile(params.profile) ? { profile: normalizeProfile(params.profile) } : {}),
  };
}

function isVolatileRoute(route: BrowserSessionTabRoute): boolean {
  return route.kind === "node-proxy" || Boolean(route.baseUrl);
}

function durableOwnership(params: SessionTabParams): DurableOwnership | undefined {
  return params.ownership?.status === "durable" ? params.ownership : undefined;
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
  identity: Pick<InteractionIdentity, "sessionKey" | "targetId" | "route" | "profile">,
): void {
  const state = volatileTabsBySession();
  const tabs = state.get(identity.sessionKey);
  if (!tabs) {
    return;
  }
  for (const [key, tab] of tabs) {
    if (volatileSessionTabTargetKey(tab) === volatileSessionTabTargetKey(identity)) {
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
  const exactKey = volatileSessionTabTargetKey(identity);
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
  ownership: BrowserTabOwnership | undefined,
  now: number,
): void {
  const state = volatileTabsBySession();
  const tabs = state.get(identity.sessionKey) ?? new Map<string, VolatileTab>();
  const key = volatileSessionTabTargetKey(identity);
  const existing = tabs.get(key);
  tabs.set(key, {
    ...identity,
    kind: "volatile",
    ...(ownership ? { ownership } : {}),
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
  if (isVolatileRoute(identity.route)) {
    upsertVolatile(identity, params.aliases ?? [], profileAliases, params.ownership, now);
    return;
  }
  if (!ownership) {
    if (!clearDurableForVolatile(identity)) {
      throw new Error("durable browser tab changed during non-durable transition");
    }
    upsertVolatile(identity, params.aliases ?? [], profileAliases, params.ownership, now);
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
  if (isVolatileRoute(identity.route)) {
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
  if (isVolatileRoute(identity.route)) {
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
  getResolvedBrowserConfig?: () => ResolvedBrowserConfig | null,
): Promise<DurableCleanupResult> {
  let resolved = getResolvedBrowserConfig?.();
  if (!resolved) {
    const cfg = getRuntimeConfig();
    resolved = resolveBrowserConfig(cfg.browser, cfg);
  }
  const profile = resolveProfile(resolved, tab.profile);
  if (!profile?.cdpUrl) {
    return { status: "ownership-mismatch" };
  }
  if (profile.driver === "extension" && !resolved.extensionRelayInternalTokens[profile.name]) {
    return { status: "unavailable", reason: "extension-relay-unavailable" };
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
  let outcome: DurableCleanupResult;
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
      outcome = await closeCurrentDurableTab(tab, shouldClose, params.getResolvedBrowserConfig);
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
    if (outcome.reason === "extension-relay-unavailable") {
      params.onWarn?.(
        `deferred tracked browser tab ${tab.nativeTargetId}: extension relay runtime unavailable`,
      );
      return 0;
    }
    // A browser that never comes back leaves its rows unreachable forever: the
    // sweep re-claims them, fails ownership lookup, and defers again. Without an
    // age bound the namespace fills to its reject-new cap and every later
    // `browser open` opens a tab, closes it again, and throws.
    if (now - tab.lastUsedAt >= BROWSER_TAB_UNREACHABLE_RETIRE_MS) {
      params.onWarn?.(
        `retired unreachable tracked browser tab ${tab.nativeTargetId}: ${outcome.reason}`,
      );
      deleteClaimedTab(tab, params.onWarn);
      return 0;
    }
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

function deleteVolatileTarget(tab: VolatileTab): void {
  const state = volatileTabsBySession();
  const targetKey = volatileSessionTabTargetKey(tab);
  for (const [sessionKey, tabs] of state) {
    for (const [key, candidate] of tabs) {
      if (volatileSessionTabTargetKey(candidate) === targetKey) {
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
  if (cleanupKind === "sweep" && !sameVolatileSessionTab(tab, candidate)) {
    return 0;
  }
  const inFlight = volatileTabCleanupByTarget();
  const targetKey = volatileSessionTabTargetKey(tab);
  const existing = inFlight.get(targetKey);
  if (existing) {
    await existing;
    return 0;
  }

  // Promise callbacks start in a microtask, so ownership is published before
  // the close callback can issue the irreversible provider operation.
  const cleanup = Promise.resolve().then(async () => {
    try {
      if (params.closeTab) {
        await params.closeTab({
          targetId: tab.targetId,
          ...(tab.route.kind === "browser-control" && tab.route.baseUrl
            ? { baseUrl: tab.route.baseUrl }
            : {}),
          ...(tab.route.kind === "node-proxy" ? { route: tab.route } : {}),
          ...(tab.profile ? { profile: tab.profile } : {}),
        });
      } else if (tab.route.kind === "node-proxy") {
        const outcome = await tab.route.closeTarget({
          targetId: tab.targetId,
          profile: tab.profile,
          ownership: tab.ownership,
        });
        if (outcome.status === "cancelled" || outcome.status === "unavailable") {
          params.onWarn?.(
            `deferred tracked browser tab ${tab.targetId}: ${outcome.status === "unavailable" ? outcome.reason : "cleanup cancelled"}`,
          );
          return 0;
        }
        if (outcome.status === "ownership-mismatch") {
          params.onWarn?.(`retired tracked browser tab ${tab.targetId}: ownership mismatch`);
          deleteVolatileTarget(tab);
          return 0;
        }
        deleteVolatileTarget(tab);
        return outcome.status === "closed" ? 1 : 0;
      } else {
        await browserCloseTabByRawTargetId(tab.route.baseUrl, tab.targetId, {
          profile: tab.profile,
        });
      }
    } catch (error) {
      if (tab.route.kind === "browser-control" && isIgnorableTabCloseError(error)) {
        deleteVolatileTarget(tab);
        return 0;
      }
      params.onWarn?.(`failed to close tracked browser tab ${tab.targetId}: ${String(error)}`);
      return 0;
    }
    deleteVolatileTarget(tab);
    return 1;
  });
  inFlight.set(targetKey, cleanup);
  try {
    return await cleanup;
  } finally {
    if (inFlight.get(targetKey) === cleanup) {
      inFlight.delete(targetKey);
    }
  }
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

/** Closes and untracks tabs for the supplied session keys. */
export async function closeTrackedBrowserTabsForSessions(
  params: CloseParams & { sessionKeys: Array<string | undefined>; now?: number },
): Promise<number> {
  const tabs = selectTrackedTabsForSessions({
    durable: readDurableTabs(params.onWarn),
    sessionKeys: params.sessionKeys,
  });
  return await closeTrackedTabs(tabs, {
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
