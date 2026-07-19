// Per-(account, database) high-water of the last durably admitted chat.db rowid.
// It advances only after the SQLite ingress enqueue, then seeds `since_rowid`
// on startup. GUID-keyed ingress tombstones make over-replay safe, while rows
// journaled before a crash resume from the queue. The store key also includes
// the database identity: a high-water from one chat.db must never seed
// since_rowid for a different one, or repointing `dbPath`/`remoteHost` to a
// lower-rowid database silently suppresses every row in it forever (#99638).
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { getIMessageRuntime } from "../runtime.js";

const IMESSAGE_RECOVERY_CURSOR_NAMESPACE = "imessage.recovery-cursor";
const IMESSAGE_RECOVERY_CURSOR_MAX_ENTRIES = 64;

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

// Mirrors monitor-provider's local Messages home resolution (HOME first, then
// os.homedir) so the identity's default path matches the database the monitor
// actually watches.
function localMessagesHomeDir(): string | undefined {
  const home = process.env.HOME?.trim();
  if (home) {
    return home;
  }
  try {
    return os.homedir().trim() || undefined;
  } catch {
    return undefined;
  }
}

// Canonicalize a local chat.db path (expand a leading ~, then resolve) so the
// implicit default and any explicit spelling of the same file share one identity.
function normalizeLocalDbPath(dbPath: string): string {
  let resolved = dbPath.trim();
  if (resolved.startsWith("~")) {
    const home = localMessagesHomeDir();
    if (home) {
      resolved = path.join(home, resolved.slice(1).replace(/^\/+/, ""));
    }
  }
  return path.resolve(resolved);
}

/**
 * Stable identity for the watched Messages database. A changed identity means a
 * different chat.db (different `dbPath`, custom `cliPath`, or a remote host),
 * whose rowids share no ordering with the previous one, so the cursor must not
 * carry across. Local paths are canonicalized so the implicit default and an
 * explicit path to the same chat.db resolve to one identity.
 */
export function resolveIMessageRecoveryCursorDbIdentity(params: {
  cliPath?: string;
  dbPath?: string;
  remoteHost?: string;
}): string {
  const remoteHost = params.remoteHost?.trim();
  if (remoteHost) {
    // Remote paths cannot be resolved locally; key by host + raw remote path.
    return `remote:${remoteHost}:${params.dbPath?.trim() || "default"}`;
  }
  const dbPath = params.dbPath?.trim();
  if (dbPath) {
    return `local:${normalizeLocalDbPath(dbPath)}`;
  }
  // No explicit dbPath: the default imsg binary watches the default chat.db, so
  // resolve it to the same concrete path an explicit config would spell. A
  // custom cliPath (e.g. an SSH wrapper whose host is not auto-detected) can
  // front a distinct database, so keep those distinct instead.
  const cliPath = params.cliPath?.trim();
  const isDefaultCli = !cliPath || cliPath === "imsg" || path.basename(cliPath) === "imsg";
  if (isDefaultCli) {
    const home = localMessagesHomeDir();
    return home
      ? `local:${normalizeLocalDbPath(path.join(home, "Library", "Messages", "chat.db"))}`
      : "local:default";
  }
  return `local:cli:${cliPath}`;
}

// Composite key: one high-water per (account, database). The NUL separator
// cannot appear in an account id or identity string, so a composite key never
// collides with the legacy account-only key adopted below.
function recoveryCursorStoreKey(accountId: string, dbIdentity: string): string {
  return `${accountId}\u0000${dbIdentity}`;
}

function readRecoveryCursor(accountId: string, dbIdentity: string): number | null {
  try {
    const store = openRecoveryCursorStore();
    const key = recoveryCursorStoreKey(accountId, dbIdentity);
    const value = store.lookup(key);
    if (value) {
      return Number.isFinite(value.lastRowid) ? value.lastRowid : null;
    }
    // One-time upgrade adoption: cursors written before database scoping were
    // keyed by accountId alone. Adopt such an entry for the active database so
    // the upgrade restart still replays downtime rows, then consume it so a
    // later dbPath change cannot inherit this database's high-water.
    const legacy = store.consume(accountId);
    if (legacy && Number.isFinite(legacy.lastRowid)) {
      store.register(key, { lastRowid: legacy.lastRowid });
      return legacy.lastRowid;
    }
    return null;
  } catch {
    return null;
  }
}

// One-time, self-cleaning migration: when the recovery cursor is empty (first
// startup after upgrade or a fresh install), seed it from the retired catchup
// cursor's lastSeenRowid and consume the legacy entry so this never runs again.
function migrateLegacyCatchupCursor(accountId: string, dbIdentity: string): number | null {
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
      advanceIMessageRecoveryCursor(accountId, dbIdentity, rowid);
    }
    return rowid;
  } catch {
    return null;
  }
}

/**
 * Last durably admitted rowid for this account on `dbIdentity`, or null when
 * none is recorded yet (including when the only stored cursor belongs to a
 * different database).
 */
export function loadIMessageRecoveryCursor(
  accountId: string,
  dbIdentity: string,
  options: { migrateLegacyCatchup?: boolean } = {},
): number | null {
  const current = readRecoveryCursor(accountId, dbIdentity);
  if (current !== null) {
    return current;
  }
  if (options.migrateLegacyCatchup === false) {
    return null;
  }
  return migrateLegacyCatchupCursor(accountId, dbIdentity);
}

/** Advance the cursor forward to `rowid` (monotonic per database; never rewinds). */
export function advanceIMessageRecoveryCursor(
  accountId: string,
  dbIdentity: string,
  rowid: number,
): void {
  if (!Number.isFinite(rowid)) {
    return;
  }
  try {
    const store = openRecoveryCursorStore();
    const key = recoveryCursorStoreKey(accountId, dbIdentity);
    const current = store.lookup(key);
    if (current && current.lastRowid >= rowid) {
      return;
    }
    store.register(key, { lastRowid: rowid });
  } catch {
    // Best effort: a failed cursor write just means we replay a little more
    // next startup, which durable ingress tombstones reject by GUID.
  }
}
