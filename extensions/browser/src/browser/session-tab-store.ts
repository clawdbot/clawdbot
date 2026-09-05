import { createHash } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { z } from "zod";
import {
  getBrowserStateRuntime,
  getOptionalBrowserStateRuntime,
  setBrowserStateRuntime,
} from "../browser-runtime-state.js";
import {
  clearDurableTabAliases,
  rememberDurableTabAliases,
  resetDurableTabAliases,
} from "./session-tab-ephemeral-aliases.js";
import {
  activeDurableStorageKeys,
  releaseColdNativeActivityOwner,
} from "./session-tab-process-state.js";

const BROWSER_SESSION_TABS_NAMESPACE = "browser.session-tabs";
const BROWSER_SESSION_TABS_MAX_ENTRIES = 5_000;

const browserSessionTimestampSchema = z.number().finite().nonnegative();
const browserProfileAliasSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim().toLowerCase());
const browserSessionTabRecordSchema = z
  .looseObject({
    version: z.literal(1),
    sessionKey: z.string().min(1),
    nativeTargetId: z.string().min(1),
    profile: z.string().min(1),
    profileAliases: z.array(browserProfileAliasSchema).min(1).optional(),
    profileFingerprint: z.string().min(1),
    browserInstanceFingerprint: z.string().min(1),
    interactionTargetKind: z.enum(["native", "opaque"]),
    trackedAt: browserSessionTimestampSchema,
    lastUsedAt: browserSessionTimestampSchema,
    cleanupRequestedAt: browserSessionTimestampSchema.optional(),
    cleanupAttemptToken: z.string().min(1).optional(),
    cleanupKind: z.enum(["lifecycle", "sweep"]).optional(),
  })
  .superRefine((record, context) => {
    if (record.profileAliases) {
      const canonical = [...new Set(record.profileAliases)].toSorted(
        compareBrowserSessionTabProfileAliases,
      );
      if (
        canonical.includes(record.profile) ||
        !canonical.every((entry, index) => entry === record.profileAliases?.[index])
      ) {
        context.addIssue({ code: "custom", message: "profile aliases must be canonical" });
      }
    }
    const cleanupFieldCount = [
      record.cleanupRequestedAt,
      record.cleanupAttemptToken,
      record.cleanupKind,
    ].filter((value) => value !== undefined).length;
    if (cleanupFieldCount !== 0 && cleanupFieldCount !== 3) {
      context.addIssue({ code: "custom", message: "cleanup fields must be all present or absent" });
    }
    if (Object.hasOwn(record, "baseUrl") || Object.hasOwn(record, "interactionTargetId")) {
      context.addIssue({ code: "custom", message: "retired browser tab fields are not allowed" });
    }
  });

export type BrowserSessionTabRecord = z.infer<typeof browserSessionTabRecordSchema>;

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

export function retireBrowserSessionTabProcessState(
  record: BrowserSessionTabRecord & { storageKey: string },
): void {
  clearDurableTabAliases(record.storageKey);
  activeDurableStorageKeys().delete(record.storageKey);
  if (record.interactionTargetKind === "native") {
    releaseColdNativeActivityOwner(browserSessionTabNativeIdentity(record));
  }
}

export function compareBrowserSessionTabProfileAliases(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseBrowserSessionTabRecord(value: unknown): BrowserSessionTabRecord | undefined {
  const parsed = browserSessionTabRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
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
