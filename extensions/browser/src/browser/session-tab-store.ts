import { createHash } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import {
  getBrowserStateRuntime,
  getOptionalBrowserStateRuntime,
  setBrowserStateRuntime,
} from "../browser-runtime-state.js";
import {
  rememberDurableTabAliases,
  resetDurableTabAliases,
} from "./session-tab-ephemeral-aliases.js";

const BROWSER_SESSION_TABS_NAMESPACE = "browser.session-tabs";
const BROWSER_SESSION_TABS_MAX_ENTRIES = 5_000;

export type BrowserSessionTabRecord = {
  version: 1;
  sessionKey: string;
  nativeTargetId: string;
  profile: string;
  profileAliases?: string[];
  profileFingerprint: string;
  browserInstanceFingerprint: string;
  interactionTargetKind: "native" | "opaque";
  trackedAt: number;
  lastUsedAt: number;
  cleanupRequestedAt?: number;
  cleanupAttemptToken?: string;
  cleanupKind?: "lifecycle" | "sweep";
};

type BrowserSessionTabStoreRuntime = {
  state: Pick<PluginRuntime["state"], "openSyncKeyedStore">;
};

/** Opens and publishes Browser's canonical durable tab store during plugin registration. */
export function initializeBrowserSessionTabStore(runtime: BrowserSessionTabStoreRuntime): void {
  const sessionTabs = runtime.state.openSyncKeyedStore<unknown>({
    namespace: BROWSER_SESSION_TABS_NAMESPACE,
    maxEntries: BROWSER_SESSION_TABS_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
  setBrowserStateRuntime({ sessionTabs });
  resetDurableTabAliases();
  for (const entry of sessionTabs.entries()) {
    const record = parseBrowserSessionTabRecord(entry.value);
    if (!record || browserSessionTabStorageKey(record) !== entry.key) {
      continue;
    }
    rememberDurableTabAliases(
      {
        sessionKey: record.sessionKey,
        targetId: record.nativeTargetId,
        profile: record.profile,
      },
      [],
      entry.key,
      record.profileAliases,
    );
  }
}

export function getBrowserSessionTabStore() {
  return getBrowserStateRuntime().sessionTabs;
}

export function getOptionalBrowserSessionTabStore() {
  return getOptionalBrowserStateRuntime()?.sessionTabs;
}

export function browserSessionTabStorageKey(record: {
  sessionKey: string;
  nativeTargetId: string;
  profileFingerprint: string;
  browserInstanceFingerprint: string;
}): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        record.sessionKey,
        record.nativeTargetId,
        record.profileFingerprint,
        record.browserInstanceFingerprint,
      ]),
    )
    .digest("hex")}`;
}

export function browserSessionTabNativeIdentity(
  record: Pick<BrowserSessionTabRecord, "sessionKey" | "profile" | "nativeTargetId">,
): string {
  return `${record.sessionKey}\u0000${record.profile}\u0000${record.nativeTargetId}`;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function compareBrowserSessionTabProfileAliases(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isCanonicalProfileAliases(
  value: unknown,
  profile: unknown,
): value is string[] | undefined {
  if (value === undefined) {
    return true;
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (entry) => typeof entry !== "string" || !entry || entry !== entry.trim().toLowerCase(),
    )
  ) {
    return false;
  }
  const canonical = [...new Set(value)].toSorted(compareBrowserSessionTabProfileAliases);
  return (
    !canonical.includes(String(profile)) &&
    canonical.every((entry, index) => entry === value[index])
  );
}

export function parseBrowserSessionTabRecord(value: unknown): BrowserSessionTabRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const cleanupFieldsValid =
    (record.cleanupRequestedAt === undefined &&
      record.cleanupAttemptToken === undefined &&
      record.cleanupKind === undefined) ||
    (isTimestamp(record.cleanupRequestedAt) &&
      typeof record.cleanupAttemptToken === "string" &&
      record.cleanupAttemptToken.length > 0 &&
      (record.cleanupKind === "lifecycle" || record.cleanupKind === "sweep"));
  if (
    record.version !== 1 ||
    typeof record.sessionKey !== "string" ||
    !record.sessionKey ||
    typeof record.nativeTargetId !== "string" ||
    !record.nativeTargetId ||
    typeof record.profile !== "string" ||
    !record.profile ||
    !isCanonicalProfileAliases(record.profileAliases, record.profile) ||
    typeof record.profileFingerprint !== "string" ||
    !record.profileFingerprint ||
    typeof record.browserInstanceFingerprint !== "string" ||
    !record.browserInstanceFingerprint ||
    (record.interactionTargetKind !== "native" && record.interactionTargetKind !== "opaque") ||
    !isTimestamp(record.trackedAt) ||
    !isTimestamp(record.lastUsedAt) ||
    !cleanupFieldsValid ||
    Object.hasOwn(record, "baseUrl") ||
    Object.hasOwn(record, "interactionTargetId")
  ) {
    return undefined;
  }
  return record as BrowserSessionTabRecord;
}

export function sameBrowserSessionTabRecord(
  left: BrowserSessionTabRecord,
  right: BrowserSessionTabRecord,
): boolean {
  return (
    left.version === right.version &&
    left.sessionKey === right.sessionKey &&
    left.nativeTargetId === right.nativeTargetId &&
    left.profile === right.profile &&
    (left.profileAliases?.length ?? 0) === (right.profileAliases?.length ?? 0) &&
    (left.profileAliases ?? []).every((alias, index) => alias === right.profileAliases?.[index]) &&
    left.profileFingerprint === right.profileFingerprint &&
    left.browserInstanceFingerprint === right.browserInstanceFingerprint &&
    left.interactionTargetKind === right.interactionTargetKind &&
    left.trackedAt === right.trackedAt &&
    left.lastUsedAt === right.lastUsedAt &&
    left.cleanupRequestedAt === right.cleanupRequestedAt &&
    left.cleanupAttemptToken === right.cleanupAttemptToken &&
    left.cleanupKind === right.cleanupKind
  );
}

export function withoutBrowserSessionTabCleanup(
  record: BrowserSessionTabRecord,
): BrowserSessionTabRecord {
  const active = { ...record };
  delete active.cleanupRequestedAt;
  delete active.cleanupAttemptToken;
  delete active.cleanupKind;
  return active;
}

export function updateBrowserSessionTab(
  key: string,
  update: (current: unknown) => BrowserSessionTabRecord | undefined,
): boolean {
  const updateStore = getBrowserSessionTabStore().update;
  if (!updateStore) {
    throw new Error("Browser session tab store requires atomic update support");
  }
  return updateStore(key, update);
}

export function deleteBrowserSessionTabIf(
  key: string,
  predicate: (current: unknown) => boolean,
): boolean {
  const deleteIf = getBrowserSessionTabStore().deleteIf;
  if (!deleteIf) {
    throw new Error("Browser session tab store requires atomic deleteIf support");
  }
  return deleteIf(key, predicate);
}
