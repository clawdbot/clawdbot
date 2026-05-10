import { chmodSync, existsSync, mkdirSync } from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { configureSqliteWalMaintenance, type SqliteWalMaintenance } from "../infra/sqlite-wal.js";
import { resolvePluginStateDir, resolvePluginStateSqlitePath } from "./plugin-state-store.paths.js";
import {
  PluginStateStoreError,
  type PluginStateEntry,
  type PluginStateStoreErrorCode,
  type PluginStateStoreOperation,
  type PluginStateStoreProbeResult,
  type PluginStateStoreProbeStep,
} from "./plugin-state-store.types.js";

const PLUGIN_STATE_SCHEMA_VERSION = 1;
const PLUGIN_STATE_DIR_MODE = 0o700;
const PLUGIN_STATE_FILE_MODE = 0o600;
const PLUGIN_STATE_SIDECAR_SUFFIXES = ["", "-shm", "-wal"] as const;
const MAX_ENTRIES_PER_PLUGIN = 1_000;

export const MAX_PLUGIN_STATE_VALUE_BYTES = 65_536;
export const MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN = MAX_ENTRIES_PER_PLUGIN;

type PluginStateRow = {
  plugin_id: string;
  namespace: string;
  entry_key: string;
  value_json: string;
  created_at: number | bigint;
  expires_at: number | bigint | null;
};

type CountRow = {
  count: number | bigint;
};

type UserVersionRow = {
  user_version?: number | bigint;
};

type PluginStateStatements = {
  upsertEntry: StatementSync;
  insertEntryIfAbsent: StatementSync;
  selectEntry: StatementSync;
  selectEntries: StatementSync;
  deleteEntry: StatementSync;
  clearNamespace: StatementSync;
  pruneExpiredNamespace: StatementSync;
  countLiveNamespace: StatementSync;
  countLivePlugin: StatementSync;
  deleteOldestNamespace: StatementSync;
  sweepExpired: StatementSync;
};

type PluginStateDatabase = {
  db: DatabaseSync;
  path: string;
  statements: PluginStateStatements;
  walMaintenance: SqliteWalMaintenance;
};

type PluginStateSeedEntryForTests = {
  pluginId: string;
  namespace: string;
  key: string;
  valueJson: string;
  createdAt?: number;
  expiresAt?: number | null;
};

let cachedDatabase: PluginStateDatabase | null = null;

function normalizeNumber(value: number | bigint | null): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}

function createPluginStateError(params: {
  code: PluginStateStoreErrorCode;
  operation: PluginStateStoreOperation;
  message: string;
  path?: string;
  cause?: unknown;
}): PluginStateStoreError {
  return new PluginStateStoreError(params.message, {
    code: params.code,
    operation: params.operation,
    ...(params.path ? { path: params.path } : {}),
    cause: params.cause,
  });
}

function wrapPluginStateError(
  error: unknown,
  operation: PluginStateStoreOperation,
  fallbackCode: PluginStateStoreErrorCode,
  message: string,
  pathname = resolvePluginStateSqlitePath(process.env),
): PluginStateStoreError {
  if (error instanceof PluginStateStoreError) {
    return error;
  }
  return createPluginStateError({
    code: fallbackCode,
    operation,
    message,
    path: pathname,
    cause: error,
  });
}

function parseStoredJson(raw: string, operation: PluginStateStoreOperation): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_CORRUPT",
      operation,
      message: "Plugin state entry contains corrupt JSON.",
      path: resolvePluginStateSqlitePath(process.env),
      cause: error,
    });
  }
}

function rowToEntry(
  row: PluginStateRow,
  operation: PluginStateStoreOperation,
): PluginStateEntry<unknown> {
  const expiresAt = normalizeNumber(row.expires_at);
  return {
    key: row.entry_key,
    value: parseStoredJson(row.value_json, operation),
    createdAt: normalizeNumber(row.created_at) ?? 0,
    ...(expiresAt != null ? { expiresAt } : {}),
  };
}

function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as UserVersionRow | undefined;
  const raw = row?.user_version ?? 0;
  return typeof raw === "bigint" ? Number(raw) : raw;
}

function ensureSchema(db: DatabaseSync, pathname: string) {
  const userVersion = getUserVersion(db);
  if (userVersion > PLUGIN_STATE_SCHEMA_VERSION) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_SCHEMA_UNSUPPORTED",
      operation: "ensure-schema",
      message: `Plugin state database schema version ${userVersion} is newer than supported version ${PLUGIN_STATE_SCHEMA_VERSION}.`,
      path: pathname,
    });
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_state_entries (
      plugin_id  TEXT    NOT NULL,
      namespace  TEXT    NOT NULL,
      entry_key  TEXT    NOT NULL,
      value_json TEXT    NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY (plugin_id, namespace, entry_key)
    );

    CREATE INDEX IF NOT EXISTS idx_plugin_state_expiry
      ON plugin_state_entries(expires_at)
      WHERE expires_at IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_plugin_state_listing
      ON plugin_state_entries(plugin_id, namespace, created_at, entry_key);

    PRAGMA user_version = ${PLUGIN_STATE_SCHEMA_VERSION};
  `);
}

function createStatements(db: DatabaseSync): PluginStateStatements {
  return {
    upsertEntry: db.prepare(`
      INSERT INTO plugin_state_entries (
        plugin_id,
        namespace,
        entry_key,
        value_json,
        created_at,
        expires_at
      ) VALUES (
        @plugin_id,
        @namespace,
        @entry_key,
        @value_json,
        @created_at,
        @expires_at
      )
      ON CONFLICT(plugin_id, namespace, entry_key) DO UPDATE SET
        value_json = excluded.value_json,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `),
    insertEntryIfAbsent: db.prepare(`
      INSERT OR IGNORE INTO plugin_state_entries (
        plugin_id,
        namespace,
        entry_key,
        value_json,
        created_at,
        expires_at
      ) VALUES (
        @plugin_id,
        @namespace,
        @entry_key,
        @value_json,
        @created_at,
        @expires_at
      )
    `),
    selectEntry: db.prepare(`
      SELECT plugin_id, namespace, entry_key, value_json, created_at, expires_at
      FROM plugin_state_entries
      WHERE plugin_id = ?
        AND namespace = ?
        AND entry_key = ?
        AND (expires_at IS NULL OR expires_at > ?)
    `),
    selectEntries: db.prepare(`
      SELECT plugin_id, namespace, entry_key, value_json, created_at, expires_at
      FROM plugin_state_entries
      WHERE plugin_id = ?
        AND namespace = ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at ASC, entry_key ASC
    `),
    deleteEntry: db.prepare(`
      DELETE FROM plugin_state_entries
      WHERE plugin_id = ? AND namespace = ? AND entry_key = ?
    `),
    clearNamespace: db.prepare(`
      DELETE FROM plugin_state_entries
      WHERE plugin_id = ? AND namespace = ?
    `),
    pruneExpiredNamespace: db.prepare(`
      DELETE FROM plugin_state_entries
      WHERE plugin_id = ?
        AND namespace = ?
        AND expires_at IS NOT NULL
        AND expires_at <= ?
    `),
    countLiveNamespace: db.prepare(`
      SELECT COUNT(*) AS count
      FROM plugin_state_entries
      WHERE plugin_id = ?
        AND namespace = ?
        AND (expires_at IS NULL OR expires_at > ?)
    `),
    countLivePlugin: db.prepare(`
      SELECT COUNT(*) AS count
      FROM plugin_state_entries
      WHERE plugin_id = ?
        AND (expires_at IS NULL OR expires_at > ?)
    `),
    deleteOldestNamespace: db.prepare(`
      DELETE FROM plugin_state_entries
      WHERE rowid IN (
        SELECT rowid
        FROM plugin_state_entries
        WHERE plugin_id = ?
          AND namespace = ?
          AND entry_key <> ?
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at ASC, entry_key ASC
        LIMIT ?
      )
    `),
    sweepExpired: db.prepare(`
      DELETE FROM plugin_state_entries
      WHERE expires_at IS NOT NULL AND expires_at <= ?
    `),
  };
}

function ensurePluginStatePermissions(pathname: string) {
  const dir = resolvePluginStateDir(process.env);
  mkdirSync(dir, { recursive: true, mode: PLUGIN_STATE_DIR_MODE });
  chmodSync(dir, PLUGIN_STATE_DIR_MODE);
  for (const suffix of PLUGIN_STATE_SIDECAR_SUFFIXES) {
    const candidate = `${pathname}${suffix}`;
    if (existsSync(candidate)) {
      chmodSync(candidate, PLUGIN_STATE_FILE_MODE);
    }
  }
}

function ensurePluginStatePermissionsBestEffort(pathname: string): void {
  try {
    ensurePluginStatePermissions(pathname);
  } catch {
    // The write already committed. Permission hardening is best-effort from here.
  }
}

function openPluginStateDatabase(
  operation: PluginStateStoreOperation = "open",
): PluginStateDatabase {
  const pathname = resolvePluginStateSqlitePath(process.env);
  if (cachedDatabase && cachedDatabase.path === pathname) {
    return cachedDatabase;
  }
  if (cachedDatabase) {
    cachedDatabase.walMaintenance.close();
    cachedDatabase.db.close();
    cachedDatabase = null;
  }

  try {
    ensurePluginStatePermissions(pathname);
  } catch (error) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_OPEN_FAILED",
      operation,
      message: "Failed to prepare the plugin state database directory.",
      path: pathname,
      cause: error,
    });
  }

  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = requireNodeSqlite();
  } catch (error) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_SQLITE_UNAVAILABLE",
      operation: "load-sqlite",
      message: "SQLite support is unavailable for plugin state storage.",
      path: pathname,
      cause: error,
    });
  }

  try {
    const db = new sqlite.DatabaseSync(pathname);
    const walMaintenance = configureSqliteWalMaintenance(db);
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    ensureSchema(db, pathname);
    ensurePluginStatePermissions(pathname);
    cachedDatabase = {
      db,
      path: pathname,
      statements: createStatements(db),
      walMaintenance,
    };
    return cachedDatabase;
  } catch (error) {
    throw wrapPluginStateError(
      error,
      operation,
      "PLUGIN_STATE_OPEN_FAILED",
      "Failed to open the plugin state database.",
      pathname,
    );
  }
}

function countRow(row: CountRow | undefined): number {
  const raw = row?.count ?? 0;
  return typeof raw === "bigint" ? Number(raw) : raw;
}

function runWriteTransaction<T>(
  operation: PluginStateStoreOperation,
  write: (store: PluginStateDatabase) => T,
): T {
  const store = openPluginStateDatabase(operation);
  ensurePluginStatePermissions(store.path);
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const result = write(store);
    store.db.exec("COMMIT");
    ensurePluginStatePermissionsBestEffort(store.path);
    return result;
  } catch (error) {
    try {
      store.db.exec("ROLLBACK");
    } catch {
      // Preserve the original failure; rollback errors are secondary here.
    }
    throw error;
  }
}

function enforcePostRegisterLimits(params: {
  store: PluginStateDatabase;
  pluginId: string;
  namespace: string;
  maxEntries: number;
  now: number;
  protectedKey: string;
}): void {
  const namespaceCount = countRow(
    params.store.statements.countLiveNamespace.get(
      params.pluginId,
      params.namespace,
      params.now,
    ) as CountRow | undefined,
  );
  if (namespaceCount > params.maxEntries) {
    params.store.statements.deleteOldestNamespace.run(
      params.pluginId,
      params.namespace,
      params.protectedKey,
      params.now,
      namespaceCount - params.maxEntries,
    );
  }

  const pluginCount = countRow(
    params.store.statements.countLivePlugin.get(params.pluginId, params.now) as
      | CountRow
      | undefined,
  );
  if (pluginCount > MAX_ENTRIES_PER_PLUGIN) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      operation: "register",
      message: `Plugin state for ${params.pluginId} exceeds the ${MAX_ENTRIES_PER_PLUGIN} live row limit.`,
      path: params.store.path,
    });
  }
}

export function pluginStateRegister(params: {
  pluginId: string;
  namespace: string;
  key: string;
  valueJson: string;
  maxEntries: number;
  ttlMs?: number;
}): void {
  try {
    runWriteTransaction("register", (store) => {
      const now = Date.now();
      const expiresAt = params.ttlMs == null ? null : now + params.ttlMs;
      store.statements.pruneExpiredNamespace.run(params.pluginId, params.namespace, now);
      store.statements.upsertEntry.run({
        plugin_id: params.pluginId,
        namespace: params.namespace,
        entry_key: params.key,
        value_json: params.valueJson,
        created_at: now,
        expires_at: expiresAt,
      });
      enforcePostRegisterLimits({
        store,
        pluginId: params.pluginId,
        namespace: params.namespace,
        maxEntries: params.maxEntries,
        now,
        protectedKey: params.key,
      });
    });
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "register",
      "PLUGIN_STATE_WRITE_FAILED",
      "Failed to register plugin state entry.",
    );
  }
}

export function pluginStateRegisterIfAbsent(params: {
  pluginId: string;
  namespace: string;
  key: string;
  valueJson: string;
  maxEntries: number;
  ttlMs?: number;
}): boolean {
  try {
    return runWriteTransaction("register", (store) => {
      const now = Date.now();
      const expiresAt = params.ttlMs == null ? null : now + params.ttlMs;
      store.statements.pruneExpiredNamespace.run(params.pluginId, params.namespace, now);
      const result = store.statements.insertEntryIfAbsent.run({
        plugin_id: params.pluginId,
        namespace: params.namespace,
        entry_key: params.key,
        value_json: params.valueJson,
        created_at: now,
        expires_at: expiresAt,
      });
      if (result.changes === 0) {
        return false;
      }
      enforcePostRegisterLimits({
        store,
        pluginId: params.pluginId,
        namespace: params.namespace,
        maxEntries: params.maxEntries,
        now,
        protectedKey: params.key,
      });
      return true;
    });
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "register",
      "PLUGIN_STATE_WRITE_FAILED",
      "Failed to register plugin state entry.",
    );
  }
}

export function pluginStateLookup(params: {
  pluginId: string;
  namespace: string;
  key: string;
}): unknown {
  try {
    const { statements } = openPluginStateDatabase("lookup");
    const row = statements.selectEntry.get(
      params.pluginId,
      params.namespace,
      params.key,
      Date.now(),
    ) as PluginStateRow | undefined;
    return row ? parseStoredJson(row.value_json, "lookup") : undefined;
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "lookup",
      "PLUGIN_STATE_READ_FAILED",
      "Failed to read plugin state entry.",
    );
  }
}

export function pluginStateConsume(params: {
  pluginId: string;
  namespace: string;
  key: string;
}): unknown {
  try {
    return runWriteTransaction("consume", (store) => {
      const row = store.statements.selectEntry.get(
        params.pluginId,
        params.namespace,
        params.key,
        Date.now(),
      ) as PluginStateRow | undefined;
      if (!row) {
        return undefined;
      }
      store.statements.deleteEntry.run(params.pluginId, params.namespace, params.key);
      return parseStoredJson(row.value_json, "consume");
    });
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "consume",
      "PLUGIN_STATE_READ_FAILED",
      "Failed to consume plugin state entry.",
    );
  }
}

export function pluginStateDelete(params: {
  pluginId: string;
  namespace: string;
  key: string;
}): boolean {
  try {
    const { statements } = openPluginStateDatabase("delete");
    const result = statements.deleteEntry.run(params.pluginId, params.namespace, params.key);
    return result.changes > 0;
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "delete",
      "PLUGIN_STATE_WRITE_FAILED",
      "Failed to delete plugin state entry.",
    );
  }
}

export function pluginStateEntries(params: {
  pluginId: string;
  namespace: string;
}): PluginStateEntry<unknown>[] {
  try {
    const { statements } = openPluginStateDatabase("entries");
    const rows = statements.selectEntries.all(
      params.pluginId,
      params.namespace,
      Date.now(),
    ) as PluginStateRow[];
    return rows.map((row) => rowToEntry(row, "entries"));
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "entries",
      "PLUGIN_STATE_READ_FAILED",
      "Failed to list plugin state entries.",
    );
  }
}

export function pluginStateClear(params: { pluginId: string; namespace: string }): void {
  try {
    const { statements } = openPluginStateDatabase("clear");
    statements.clearNamespace.run(params.pluginId, params.namespace);
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "clear",
      "PLUGIN_STATE_WRITE_FAILED",
      "Failed to clear plugin state namespace.",
    );
  }
}

export function sweepExpiredPluginStateEntries(): number {
  try {
    const { statements } = openPluginStateDatabase("sweep");
    const result = statements.sweepExpired.run(Date.now());
    return Number(result.changes);
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "sweep",
      "PLUGIN_STATE_WRITE_FAILED",
      "Failed to sweep expired plugin state entries.",
    );
  }
}

export function isPluginStateDatabaseOpen(): boolean {
  return cachedDatabase !== null;
}

export function clearPluginStateSqliteStoreForTests(): void {
  const store = openPluginStateDatabase("clear");
  store.db.exec("DELETE FROM plugin_state_entries;");
}

export function seedPluginStateSqliteEntriesForTests(
  entries: readonly PluginStateSeedEntryForTests[],
): void {
  if (entries.length === 0) {
    return;
  }

  const now = Date.now();
  runWriteTransaction("register", (store) => {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      store.statements.upsertEntry.run({
        plugin_id: entry.pluginId,
        namespace: entry.namespace,
        entry_key: entry.key,
        value_json: entry.valueJson,
        created_at: entry.createdAt ?? now + index,
        expires_at: entry.expiresAt ?? null,
      });
    }
  });
}

export function probePluginStateStore(): PluginStateStoreProbeResult {
  const dbPath = resolvePluginStateSqlitePath(process.env);
  const steps: PluginStateStoreProbeStep[] = [];
  const wasOpen = cachedDatabase !== null;

  const pushOk = (name: string) => steps.push({ name, ok: true });
  const pushFailure = (name: string, error: unknown) => {
    const wrapped =
      error instanceof PluginStateStoreError
        ? error
        : createPluginStateError({
            code: "PLUGIN_STATE_OPEN_FAILED",
            operation: "probe",
            message: error instanceof Error ? error.message : String(error),
            path: dbPath,
            cause: error,
          });
    steps.push({ name, ok: false, code: wrapped.code, message: wrapped.message });
  };

  try {
    ensurePluginStatePermissions(dbPath);
    pushOk("state-dir");
  } catch (error) {
    pushFailure("state-dir", error);
    return { ok: false, dbPath, steps };
  }

  try {
    requireNodeSqlite();
    pushOk("load-sqlite");
  } catch (error) {
    pushFailure(
      "load-sqlite",
      createPluginStateError({
        code: "PLUGIN_STATE_SQLITE_UNAVAILABLE",
        operation: "load-sqlite",
        message: "SQLite support is unavailable for plugin state storage.",
        path: dbPath,
        cause: error,
      }),
    );
    return { ok: false, dbPath, steps };
  }

  try {
    const store = openPluginStateDatabase("probe");
    pushOk("open");
    ensureSchema(store.db, store.path);
    pushOk("schema");
    runWriteTransaction("probe", ({ statements }) => {
      const now = Date.now();
      statements.upsertEntry.run({
        plugin_id: "core:plugin-state-probe",
        namespace: "diagnostics",
        entry_key: "probe",
        value_json: JSON.stringify({ ok: true }),
        created_at: now,
        expires_at: now + 60_000,
      });
      statements.selectEntry.get("core:plugin-state-probe", "diagnostics", "probe", now);
      statements.deleteEntry.run("core:plugin-state-probe", "diagnostics", "probe");
    });
    pushOk("write-read-delete");
    store.walMaintenance.checkpoint();
    pushOk("checkpoint");
  } catch (error) {
    pushFailure("probe", error);
  } finally {
    if (!wasOpen) {
      closePluginStateSqliteStore();
    }
  }

  return { ok: steps.every((step) => step.ok), dbPath, steps };
}

export function closePluginStateSqliteStore(): void {
  if (!cachedDatabase) {
    return;
  }
  try {
    cachedDatabase.walMaintenance.close();
    cachedDatabase.db.close();
    cachedDatabase = null;
  } catch (error) {
    cachedDatabase = null;
    throw wrapPluginStateError(
      error,
      "close",
      "PLUGIN_STATE_WRITE_FAILED",
      "Failed to close plugin state database.",
    );
  }
}
