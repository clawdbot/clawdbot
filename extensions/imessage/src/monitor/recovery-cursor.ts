// Per-account high-water of the last dispatched chat.db rowid. On startup it is
// passed to imsg `watch.subscribe` as `since_rowid` so imsg replays the rows
// that landed while the gateway was down (downtime recovery), then tails live.
// The GUID dedupe makes this safe — anything already handled is dropped — so
// this needs none of the cursor/retry bookkeeping the old catchup subsystem
// carried. Single number per account.
import { createHash } from "node:crypto";
import { getIMessageRuntime } from "../runtime.js";

export const IMESSAGE_RECOVERY_CURSOR_NAMESPACE = "imessage.recovery-cursor";
export const IMESSAGE_RECOVERY_CURSOR_MAX_ENTRIES = 64;

// Retired catchup cursor, seeded into the recovery cursor once on upgrade (see
// loadIMessageRecoveryCursor) so a user who had catchup enabled still recovers
// messages missed across the upgrade restart.
const LEGACY_CATCHUP_CURSOR_NAMESPACE = "imessage.catchup-cursors";
const LEGACY_CATCHUP_CURSOR_MAX_ENTRIES = 256;

type RecoveryCursor = { lastRowid: number };

function openRecoveryCursorStore() {
  return getIMessageRuntime().state.openSyncKeyedStore<RecoveryCursor>({
    namespace: IMESSAGE_RECOVERY_CURSOR_NAMESPACE,
    maxEntries: IMESSAGE_RECOVERY_CURSOR_MAX_ENTRIES,
  });
}

function readRecoveryCursor(accountId: string): number | null {
  try {
    const value = openRecoveryCursorStore().lookup(accountId);
    return typeof value?.lastRowid === "number" && Number.isFinite(value.lastRowid)
      ? value.lastRowid
      : null;
  } catch {
    return null;
  }
}

// One-time, self-cleaning migration: when the recovery cursor is empty (first
// startup after upgrade or a fresh install), seed it from the retired catchup
// cursor's lastSeenRowid and consume the legacy entry so this never runs again.
function migrateLegacyCatchupCursor(accountId: string): number | null {
  try {
    const legacy = getIMessageRuntime().state.openSyncKeyedStore<{ lastSeenRowid?: unknown }>({
      namespace: LEGACY_CATCHUP_CURSOR_NAMESPACE,
      maxEntries: LEGACY_CATCHUP_CURSOR_MAX_ENTRIES,
    });
    const key = createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 32);
    const value = legacy.consume(key);
    const rowid =
      typeof value?.lastSeenRowid === "number" && Number.isFinite(value.lastSeenRowid)
        ? value.lastSeenRowid
        : null;
    if (rowid !== null) {
      advanceIMessageRecoveryCursor(accountId, rowid);
    }
    return rowid;
  } catch {
    return null;
  }
}

/** Last dispatched rowid for this account, or null when none is recorded yet. */
export function loadIMessageRecoveryCursor(
  accountId: string,
  options: { migrateLegacyCatchup?: boolean } = {},
): number | null {
  const current = readRecoveryCursor(accountId);
  if (current !== null) {
    return current;
  }
  if (options.migrateLegacyCatchup === false) {
    return null;
  }
  return migrateLegacyCatchupCursor(accountId);
}

/** Advance the cursor forward to `rowid` (monotonic; never rewinds). */
export function advanceIMessageRecoveryCursor(accountId: string, rowid: number): void {
  if (!Number.isFinite(rowid)) {
    return;
  }
  try {
    const store = openRecoveryCursorStore();
    const current = store.lookup(accountId);
    if (current && current.lastRowid >= rowid) {
      return;
    }
    store.register(accountId, { lastRowid: rowid });
  } catch {
    // Best effort: a failed cursor write just means we replay a little more
    // next startup, which the dedupe absorbs.
  }
}
