/**
 * Cleanup claim bookkeeping for durable session tabs. A claim marks a row as
 * being closed by exactly one attempt, so a concurrent touch or a competing
 * sweep cannot delete a row that another generation now owns.
 */
import { randomUUID } from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { clearDurableTabAliases } from "./session-tab-ephemeral-aliases.js";
import { activeDurableStorageKeys } from "./session-tab-process-state.js";
import {
  type BrowserSessionTabRecord,
  deleteBrowserSessionTabIf,
  getBrowserSessionTabStore,
  parseBrowserSessionTabRecord,
  sameBrowserSessionTabRecord,
  updateBrowserSessionTab,
} from "./session-tab-store.js";

type DurableTab = BrowserSessionTabRecord & {
  kind: "durable";
  storageKey: string;
};

export type CleanupKind = "lifecycle" | "sweep";

export function isIgnorableTabCloseError(error: unknown): boolean {
  const message = normalizeLowercaseStringOrEmpty(String(error));
  return (
    message.includes("tab not found") ||
    message.includes("target closed") ||
    message.includes("target not found") ||
    message.includes("no such target") ||
    message.includes("no target with given id found")
  );
}

export function claimCleanup(
  tab: DurableTab,
  now: number,
  kind: CleanupKind,
): DurableTab | undefined {
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

export function ownsCleanupAttempt(tab: DurableTab): boolean {
  const current = parseBrowserSessionTabRecord(getBrowserSessionTabStore().lookup(tab.storageKey));
  return matchesCleanupAttempt(current, tab);
}

export function deleteClaimedTab(tab: DurableTab, onWarn?: (message: string) => void): void {
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
