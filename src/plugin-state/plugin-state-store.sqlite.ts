// Plugin state SQLite helpers persist plugin state in the OpenClaw state database.
import type { DatabaseSync } from "node:sqlite";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import type { Insertable, Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabase,
  isOpenClawStateDatabaseOpen,
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  PluginStateStoreError,
  type PluginStateEntry,
  type PluginStateOverflowPolicy,
  type PluginStateStoreErrorCode,
  type PluginStateStoreOperation,
  type PluginStateStoreProbeResult,
  type PluginStateStoreProbeStep,
} from "./plugin-state-store.types.js";

// Plugin-wide fuse only; namespace maxEntries still owns normal cache eviction.
export const MAX_PLUGIN_STATE_VALUE_BYTES = 65_536;
export const MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN = 50_000;
let maxPluginStateEntriesPerPluginForTests: number | undefined;

type PluginStateEntriesTable = OpenClawStateKyselyDatabase["plugin_state_entries"];
type PluginStateStoreDatabase = Pick<OpenClawStateKyselyDatabase, "plugin_state_entries">;

type PluginStateRow = Selectable<PluginStateEntriesTable>;

type CountRow = {
  count: number | bigint;
};

type PluginStateDatabase = {
  db: DatabaseSync;
  path: string;
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

function resolvePluginStateExpiresAtMs(params: {
  ttlMs: number | undefined;
  now: number;
  operation: PluginStateStoreOperation;
  path?: string;
}): number | null {
  if (params.ttlMs == null) {
    return null;
  }
  const expiresAt = resolveExpiresAtMsFromDurationMs(params.ttlMs, { nowMs: params.now });
  if (expiresAt === undefined) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: params.operation,
      message: "Plugin state ttlMs cannot produce a valid expiry timestamp.",
      ...(params.path ? { path: params.path } : {}),
    });
  }
  return expiresAt;
}

function wrapPluginStateError(
  error: unknown,
  operation: PluginStateStoreOperation,
  fallbackCode: PluginStateStoreErrorCode,
  message: string,
  pathname = resolveOpenClawStateSqlitePath(process.env),
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
      path: resolveOpenClawStateSqlitePath(process.env),
      cause: error,
    });
  }
}

function rowToEntry(
  row: PluginStateRow,
  operation: PluginStateStoreOperation,
): PluginStateEntry<unknown> {
  const expiresAt = normalizeSqliteNumber(row.expires_at);
  return {
    key: row.entry_key,
    value: parseStoredJson(row.value_json, operation),
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    ...(expiresAt != null ? { expiresAt } : {}),
  };
}

function getPluginStateKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<PluginStateStoreDatabase>(db);
}

function bindPluginStateEntry(params: {
  pluginId: string;
  namespace: string;
  key: string;
  valueJson: string;
  createdAt: number;
  expiresAt: number | null;
}): Insertable<PluginStateEntriesTable> {
  return {
    plugin_id: params.pluginId,
    namespace: params.namespace,
    entry_key: params.key,
    value_json: params.valueJson,
    created_at: params.createdAt,
    expires_at: params.expiresAt,
  };
}

function upsertPluginStateEntry(db: DatabaseSync, row: Insertable<PluginStateEntriesTable>): void {
  executeSqliteQuerySync(
    db,
    getPluginStateKysely(db)
      .insertInto("plugin_state_entries")
      .values(row)
      .onConflict((conflict) =>
        conflict.columns(["plugin_id", "namespace", "entry_key"]).doUpdateSet({
          value_json: (eb) => eb.ref("excluded.value_json"),
          created_at: (eb) => eb.ref("excluded.created_at"),
          expires_at: (eb) => eb.ref("excluded.expires_at"),
        }),
      ),
  );
}

function insertPluginStateEntryIfAbsent(
  db: DatabaseSync,
  row: Insertable<PluginStateEntriesTable>,
): boolean {
  const result = executeSqliteQuerySync(
    db,
    getPluginStateKysely(db).insertInto("plugin_state_entries").orIgnore().values(row),
  );
  return Number(result.numAffectedRows ?? 0) > 0;
}

function selectPluginStateEntry(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; key: string; now: number },
): PluginStateRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    getPluginStateKysely(db)
      .selectFrom("plugin_state_entries")
      .select(["plugin_id", "namespace", "entry_key", "value_json", "created_at", "expires_at"])
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where("entry_key", "=", params.key)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", params.now)])),
  );
}

function selectPluginStateEntries(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; now: number },
): PluginStateRow[] {
  return executeSqliteQuerySync(
    db,
    getPluginStateKysely(db)
      .selectFrom("plugin_state_entries")
      .select(["plugin_id", "namespace", "entry_key", "value_json", "created_at", "expires_at"])
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", params.now)]))
      .orderBy("created_at", "asc")
      .orderBy("entry_key", "asc"),
  ).rows;
}

function selectPluginStateEntriesInKeyRange(
  db: DatabaseSync,
  params: {
    pluginId: string;
    namespace: string;
    keyStartInclusive: string;
    keyEndExclusive: string;
    limit: number;
    order: "asc" | "desc";
    now: number;
  },
): PluginStateRow[] {
  return executeSqliteQuerySync(
    db,
    getPluginStateKysely(db)
      .selectFrom("plugin_state_entries")
      .select(["plugin_id", "namespace", "entry_key", "value_json", "created_at", "expires_at"])
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where("entry_key", ">=", params.keyStartInclusive)
      .where("entry_key", "<", params.keyEndExclusive)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", params.now)]))
      .orderBy("entry_key", params.order)
      .limit(params.limit),
  ).rows;
}

function deletePluginStateEntry(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; key: string },
): number {
  const result = executeSqliteQuerySync(
    db,
    getPluginStateKysely(db)
      .deleteFrom("plugin_state_entries")
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where("entry_key", "=", params.key),
  );
  return Number(result.numAffectedRows ?? 0);
}

function deleteExpiredPluginStateNamespaceEntries(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; now: number },
): void {
  executeSqliteQuerySync(
    db,
    getPluginStateKysely(db)
      .deleteFrom("plugin_state_entries")
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where("expires_at", "is not", null)
      .where("expires_at", "<=", params.now),
  );
}

function countLivePluginStateNamespaceEntries(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; now: number },
): number {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getPluginStateKysely(db)
      .selectFrom("plugin_state_entries")
      .select((eb) => eb.fn.countAll<number | bigint>().as("count"))
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", params.now)])),
  );
  return countRow(row);
}

function allocatePluginStateNamespaceCreatedAt(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; now: number },
): number {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getPluginStateKysely(db)
      .selectFrom("plugin_state_entries")
      .select((eb) => eb.fn.max<number | bigint>("created_at").as("max_created_at"))
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace),
  );
  const previous = normalizeSqliteNumber(row?.max_created_at ?? null);
  const next = previous === undefined ? params.now : Math.max(params.now, previous + 1);
  if (!Number.isSafeInteger(next)) {
    throw new RangeError("Plugin state namespace append order exhausted safe integer range");
  }
  return next;
}

function countLivePluginStateEntries(
  db: DatabaseSync,
  params: { pluginId: string; now: number },
): number {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getPluginStateKysely(db)
      .selectFrom("plugin_state_entries")
      .select((eb) => eb.fn.countAll<number | bigint>().as("count"))
      .where("plugin_id", "=", params.pluginId)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", params.now)])),
  );
  return countRow(row);
}

function deleteOldestPluginStateNamespaceEntries(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; protectedKey: string; now: number; limit: number },
): void {
  const keys = executeSqliteQuerySync(
    db,
    getPluginStateKysely(db)
      .selectFrom("plugin_state_entries")
      .select(["entry_key"])
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where("entry_key", "!=", params.protectedKey)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", params.now)]))
      .orderBy("created_at", "asc")
      .orderBy("entry_key", "asc")
      .limit(params.limit),
  ).rows;
  for (const row of keys) {
    deletePluginStateEntry(db, {
      pluginId: params.pluginId,
      namespace: params.namespace,
      key: row.entry_key,
    });
  }
}

function sweepExpiredPluginStateEntriesFromDatabase(db: DatabaseSync, now: number): number {
  const result = executeSqliteQuerySync(
    db,
    getPluginStateKysely(db)
      .deleteFrom("plugin_state_entries")
      .where("expires_at", "is not", null)
      .where("expires_at", "<=", now),
  );
  return Number(result.numAffectedRows ?? 0);
}

function openPluginStateDatabase(
  operation: PluginStateStoreOperation = "open",
  options: OpenClawStateDatabaseOptions = {},
): PluginStateDatabase {
  const env = options.env ?? process.env;
  const pathname = resolveOpenClawStateSqlitePath(env);
  if (cachedDatabase && cachedDatabase.path === pathname && cachedDatabase.db.isOpen) {
    return cachedDatabase;
  }
  if (cachedDatabase && !cachedDatabase.db.isOpen) {
    cachedDatabase = null;
  }

  try {
    const database = openOpenClawStateDatabase(options);
    cachedDatabase = {
      db: database.db,
      path: database.path,
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

function envOptions(env?: NodeJS.ProcessEnv): OpenClawStateDatabaseOptions {
  return env ? { env } : {};
}

function runWriteTransaction<T>(
  operation: PluginStateStoreOperation,
  write: (store: PluginStateDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): T {
  const store = openPluginStateDatabase(operation, options);
  return runOpenClawStateWriteTransaction(() => {
    const result = write(store);
    return result;
  }, options);
}

function enforcePostRegisterLimits(params: {
  store: PluginStateDatabase;
  pluginId: string;
  namespace: string;
  maxEntries: number;
  overflowPolicy: PluginStateOverflowPolicy;
  now: number;
  protectedKey: string;
  enforcePluginLimit?: boolean;
}): void {
  if (params.overflowPolicy === "reject-new") {
    return;
  }
  const namespaceCount = countLivePluginStateNamespaceEntries(params.store.db, {
    pluginId: params.pluginId,
    namespace: params.namespace,
    now: params.now,
  });
  if (namespaceCount > params.maxEntries) {
    deleteOldestPluginStateNamespaceEntries(params.store.db, {
      pluginId: params.pluginId,
      namespace: params.namespace,
      protectedKey: params.protectedKey,
      now: params.now,
      limit: namespaceCount - params.maxEntries,
    });
  }

  if (params.enforcePluginLimit === false) {
    return;
  }

  const pluginCount = countLivePluginStateEntries(params.store.db, {
    pluginId: params.pluginId,
    now: params.now,
  });
  const maxPluginEntries = resolveMaxPluginStateEntriesPerPlugin();
  if (pluginCount <= maxPluginEntries) {
    return;
  }

  // Shed only rows from the namespace that grew. Sibling namespaces can hold
  // durable state; if this namespace cannot cover the overflow, fail so the
  // surrounding transaction rolls every insertion and deletion back.
  deleteOldestPluginStateNamespaceEntries(params.store.db, {
    pluginId: params.pluginId,
    namespace: params.namespace,
    protectedKey: params.protectedKey,
    now: params.now,
    limit: pluginCount - maxPluginEntries,
  });
  const remainingPluginCount = countLivePluginStateEntries(params.store.db, {
    pluginId: params.pluginId,
    now: params.now,
  });
  if (remainingPluginCount > maxPluginEntries) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      operation: "register",
      message: `Plugin state for ${params.pluginId} exceeds the ${maxPluginEntries} live row limit.`,
      path: params.store.path,
    });
  }
}

function assertCanInsertPluginStateEntry(params: {
  store: PluginStateDatabase;
  pluginId: string;
  namespace: string;
  maxEntries: number;
  overflowPolicy: PluginStateOverflowPolicy;
  now: number;
}): void {
  if (params.overflowPolicy !== "reject-new") {
    return;
  }
  const namespaceCount = countLivePluginStateNamespaceEntries(params.store.db, {
    pluginId: params.pluginId,
    namespace: params.namespace,
    now: params.now,
  });
  if (namespaceCount >= params.maxEntries) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      operation: "register",
      message: `Plugin state namespace ${params.namespace} for ${params.pluginId} reached its ${params.maxEntries}-row limit.`,
      path: params.store.path,
    });
  }
  const maxPluginEntries = resolveMaxPluginStateEntriesPerPlugin();
  const pluginCount = countLivePluginStateEntries(params.store.db, {
    pluginId: params.pluginId,
    now: params.now,
  });
  if (pluginCount >= maxPluginEntries) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      operation: "register",
      message: `Plugin state for ${params.pluginId} reached the ${maxPluginEntries} live row limit.`,
      path: params.store.path,
    });
  }
}

export function resolveMaxPluginStateEntriesPerPlugin(): number {
  return maxPluginStateEntriesPerPluginForTests ?? MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN;
}

export function pluginStateRegister(params: {
  pluginId: string;
  namespace: string;
  key: string;
  valueJson: string;
  maxEntries: number;
  overflowPolicy: PluginStateOverflowPolicy;
  ttlMs?: number;
  // Migration-only override: eviction orders rows by created_at, so imported
  // legacy rows must keep their original age instead of the import time.
  createdAtMs?: number;
  env?: NodeJS.ProcessEnv;
}): void {
  try {
    runWriteTransaction(
      "register",
      (store) => {
        const now = Date.now();
        const expiresAt = resolvePluginStateExpiresAtMs({
          ttlMs: params.ttlMs,
          now,
          operation: "register",
          path: store.path,
        });
        deleteExpiredPluginStateNamespaceEntries(store.db, {
          pluginId: params.pluginId,
          namespace: params.namespace,
          now,
        });
        const existing = selectPluginStateEntry(store.db, {
          pluginId: params.pluginId,
          namespace: params.namespace,
          key: params.key,
          now,
        });
        if (!existing) {
          assertCanInsertPluginStateEntry({
            store,
            pluginId: params.pluginId,
            namespace: params.namespace,
            maxEntries: params.maxEntries,
            overflowPolicy: params.overflowPolicy,
            now,
          });
        }
        upsertPluginStateEntry(
          store.db,
          bindPluginStateEntry({
            pluginId: params.pluginId,
            namespace: params.namespace,
            key: params.key,
            valueJson: params.valueJson,
            createdAt: params.createdAtMs ?? now,
            expiresAt,
          }),
        );
        enforcePostRegisterLimits({
          store,
          pluginId: params.pluginId,
          namespace: params.namespace,
          maxEntries: params.maxEntries,
          overflowPolicy: params.overflowPolicy,
          now,
          protectedKey: params.key,
        });
      },
      envOptions(params.env),
    );
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "register",
      "PLUGIN_STATE_WRITE_FAILED",
      "Failed to register plugin state entry.",
    );
  }
}

export function pluginStateRegisterSequencedJournalEntry(params: {
  pluginId: string;
  cursorNamespace: string;
  cursorKey: string;
  cursorMaxEntries: number;
  journalNamespace: string;
  journalMaxEntries: number;
  initialSequence: number;
  readCursorSequence: (valueJson: string) => number | undefined;
  prepareEntry: (sequence: number) => {
    cursorValueJson: string;
    journalKey: string;
    journalValueJson: string;
  };
  env?: NodeJS.ProcessEnv;
}): number {
  try {
    return runWriteTransaction(
      "register",
      (store) => {
        const now = Date.now();
        deleteExpiredPluginStateNamespaceEntries(store.db, {
          pluginId: params.pluginId,
          namespace: params.cursorNamespace,
          now,
        });
        deleteExpiredPluginStateNamespaceEntries(store.db, {
          pluginId: params.pluginId,
          namespace: params.journalNamespace,
          now,
        });
        const cursor = selectPluginStateEntry(store.db, {
          pluginId: params.pluginId,
          namespace: params.cursorNamespace,
          key: params.cursorKey,
          now,
        });
        const cursorSequence = cursor ? params.readCursorSequence(cursor.value_json) : undefined;
        const lastSequence = Math.max(params.initialSequence, cursorSequence ?? 0);
        const sequence = lastSequence + 1;
        if (!Number.isSafeInteger(sequence)) {
          throw new RangeError("Plugin state journal sequence exhausted safe integer range");
        }
        const prepared = params.prepareEntry(sequence);
        const existingJournalEntry = selectPluginStateEntry(store.db, {
          pluginId: params.pluginId,
          namespace: params.journalNamespace,
          key: prepared.journalKey,
          now,
        });
        if (existingJournalEntry) {
          throw createPluginStateError({
            code: "PLUGIN_STATE_WRITE_FAILED",
            operation: "register",
            message: "Plugin state journal sequence already exists.",
            path: store.path,
          });
        }
        if (!cursor) {
          assertCanInsertPluginStateEntry({
            store,
            pluginId: params.pluginId,
            namespace: params.cursorNamespace,
            maxEntries: params.cursorMaxEntries,
            overflowPolicy: "evict-oldest",
            now,
          });
        }
        assertCanInsertPluginStateEntry({
          store,
          pluginId: params.pluginId,
          namespace: params.journalNamespace,
          maxEntries: params.journalMaxEntries,
          overflowPolicy: "evict-oldest",
          now,
        });
        upsertPluginStateEntry(
          store.db,
          bindPluginStateEntry({
            pluginId: params.pluginId,
            namespace: params.cursorNamespace,
            key: params.cursorKey,
            valueJson: prepared.cursorValueJson,
            createdAt: now,
            expiresAt: null,
          }),
        );
        enforcePostRegisterLimits({
          store,
          pluginId: params.pluginId,
          namespace: params.cursorNamespace,
          maxEntries: params.cursorMaxEntries,
          overflowPolicy: "evict-oldest",
          now,
          protectedKey: params.cursorKey,
          enforcePluginLimit: false,
        });
        upsertPluginStateEntry(
          store.db,
          bindPluginStateEntry({
            pluginId: params.pluginId,
            namespace: params.journalNamespace,
            key: prepared.journalKey,
            valueJson: prepared.journalValueJson,
            createdAt: allocatePluginStateNamespaceCreatedAt(store.db, {
              pluginId: params.pluginId,
              namespace: params.journalNamespace,
              now,
            }),
            expiresAt: null,
          }),
        );
        enforcePostRegisterLimits({
          store,
          pluginId: params.pluginId,
          namespace: params.journalNamespace,
          maxEntries: params.journalMaxEntries,
          overflowPolicy: "evict-oldest",
          now,
          protectedKey: prepared.journalKey,
        });
        return sequence;
      },
      envOptions(params.env),
    );
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "register",
      "PLUGIN_STATE_WRITE_FAILED",
      "Failed to register sequenced plugin state journal entry.",
    );
  }
}

export function pluginStateRegisterIfAbsent(params: {
  pluginId: string;
  namespace: string;
  key: string;
  valueJson: string;
  maxEntries: number;
  overflowPolicy: PluginStateOverflowPolicy;
  ttlMs?: number;
  env?: NodeJS.ProcessEnv;
}): boolean {
  try {
    return runWriteTransaction(
      "register",
      (store) => {
        const now = Date.now();
        const expiresAt = resolvePluginStateExpiresAtMs({
          ttlMs: params.ttlMs,
          now,
          operation: "register",
          path: store.path,
        });
        deleteExpiredPluginStateNamespaceEntries(store.db, {
          pluginId: params.pluginId,
          namespace: params.namespace,
          now,
        });
        const existing = selectPluginStateEntry(store.db, {
          pluginId: params.pluginId,
          namespace: params.namespace,
          key: params.key,
          now,
        });
        if (existing) {
          return false;
        }
        assertCanInsertPluginStateEntry({
          store,
          pluginId: params.pluginId,
          namespace: params.namespace,
          maxEntries: params.maxEntries,
          overflowPolicy: params.overflowPolicy,
          now,
        });
        const inserted = insertPluginStateEntryIfAbsent(
          store.db,
          bindPluginStateEntry({
            pluginId: params.pluginId,
            namespace: params.namespace,
            key: params.key,
            valueJson: params.valueJson,
            createdAt: now,
            expiresAt,
          }),
        );
        if (!inserted) {
          return false;
        }
        enforcePostRegisterLimits({
          store,
          pluginId: params.pluginId,
          namespace: params.namespace,
          maxEntries: params.maxEntries,
          overflowPolicy: params.overflowPolicy,
          now,
          protectedKey: params.key,
        });
        return true;
      },
      envOptions(params.env),
    );
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "register",
      "PLUGIN_STATE_WRITE_FAILED",
      "Failed to register plugin state entry.",
    );
  }
}

export function pluginStateUpdate(params: {
  pluginId: string;
  namespace: string;
  key: string;
  maxEntries: number;
  overflowPolicy: PluginStateOverflowPolicy;
  updateValueJson: (current: unknown) => { valueJson: string; ttlMs?: number } | undefined;
  env?: NodeJS.ProcessEnv;
}): boolean {
  try {
    return runWriteTransaction(
      "register",
      (store) => {
        const now = Date.now();
        deleteExpiredPluginStateNamespaceEntries(store.db, {
          pluginId: params.pluginId,
          namespace: params.namespace,
          now,
        });
        const existing = selectPluginStateEntry(store.db, {
          pluginId: params.pluginId,
          namespace: params.namespace,
          key: params.key,
          now,
        });
        const next = params.updateValueJson(
          existing ? parseStoredJson(existing.value_json, "lookup") : undefined,
        );
        if (!next) {
          return false;
        }
        if (!existing) {
          assertCanInsertPluginStateEntry({
            store,
            pluginId: params.pluginId,
            namespace: params.namespace,
            maxEntries: params.maxEntries,
            overflowPolicy: params.overflowPolicy,
            now,
          });
        }
        const expiresAt = resolvePluginStateExpiresAtMs({
          ttlMs: next.ttlMs,
          now,
          operation: "register",
          path: store.path,
        });
        upsertPluginStateEntry(
          store.db,
          bindPluginStateEntry({
            pluginId: params.pluginId,
            namespace: params.namespace,
            key: params.key,
            valueJson: next.valueJson,
            createdAt: now,
            expiresAt,
          }),
        );
        enforcePostRegisterLimits({
          store,
          pluginId: params.pluginId,
          namespace: params.namespace,
          maxEntries: params.maxEntries,
          overflowPolicy: params.overflowPolicy,
          now,
          protectedKey: params.key,
        });
        return true;
      },
      envOptions(params.env),
    );
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "register",
      "PLUGIN_STATE_WRITE_FAILED",
      "Failed to update plugin state entry.",
    );
  }
}

export function pluginStateLookup(params: {
  pluginId: string;
  namespace: string;
  key: string;
  env?: NodeJS.ProcessEnv;
}): unknown {
  try {
    const { db } = openPluginStateDatabase("lookup", envOptions(params.env));
    const row = selectPluginStateEntry(db, {
      pluginId: params.pluginId,
      namespace: params.namespace,
      key: params.key,
      now: Date.now(),
    });
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
  env?: NodeJS.ProcessEnv;
}): unknown {
  try {
    return runWriteTransaction(
      "consume",
      (store) => {
        const row = selectPluginStateEntry(store.db, {
          pluginId: params.pluginId,
          namespace: params.namespace,
          key: params.key,
          now: Date.now(),
        });
        if (!row) {
          return undefined;
        }
        deletePluginStateEntry(store.db, params);
        return parseStoredJson(row.value_json, "consume");
      },
      envOptions(params.env),
    );
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
  env?: NodeJS.ProcessEnv;
}): boolean {
  try {
    return runWriteTransaction(
      "delete",
      ({ db }) => {
        return deletePluginStateEntry(db, params) > 0;
      },
      envOptions(params.env),
    );
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "delete",
      "PLUGIN_STATE_WRITE_FAILED",
      "Failed to delete plugin state entry.",
    );
  }
}

export function pluginStateDeleteIf(params: {
  pluginId: string;
  namespace: string;
  key: string;
  predicate: (current: unknown) => boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  try {
    return runWriteTransaction(
      "delete",
      ({ db }) => {
        const row = selectPluginStateEntry(db, {
          pluginId: params.pluginId,
          namespace: params.namespace,
          key: params.key,
          now: Date.now(),
        });
        if (!row || !params.predicate(parseStoredJson(row.value_json, "delete"))) {
          return false;
        }
        return deletePluginStateEntry(db, params) > 0;
      },
      envOptions(params.env),
    );
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "delete",
      "PLUGIN_STATE_WRITE_FAILED",
      "Failed to conditionally delete plugin state entry.",
    );
  }
}

export function pluginStateEntries(params: {
  pluginId: string;
  namespace: string;
  env?: NodeJS.ProcessEnv;
}): PluginStateEntry<unknown>[] {
  try {
    const { db } = openPluginStateDatabase("entries", envOptions(params.env));
    const rows = selectPluginStateEntries(db, {
      pluginId: params.pluginId,
      namespace: params.namespace,
      now: Date.now(),
    });
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

/** Internal bounded key-range read for core owners with sortable plugin-state keys. */
export function pluginStateEntriesInKeyRange(params: {
  pluginId: string;
  namespace: string;
  keyStartInclusive: string;
  keyEndExclusive: string;
  limit: number;
  order?: "asc" | "desc";
  env?: NodeJS.ProcessEnv;
}): PluginStateEntry<unknown>[] {
  if (!Number.isSafeInteger(params.limit) || params.limit < 1) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: "entries",
      message: "Plugin state key-range limit must be a positive safe integer.",
    });
  }
  if (params.keyStartInclusive >= params.keyEndExclusive) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: "entries",
      message: "Plugin state key range must have an increasing exclusive upper bound.",
    });
  }
  try {
    const { db } = openPluginStateDatabase("entries", envOptions(params.env));
    return selectPluginStateEntriesInKeyRange(db, {
      pluginId: params.pluginId,
      namespace: params.namespace,
      keyStartInclusive: params.keyStartInclusive,
      keyEndExclusive: params.keyEndExclusive,
      limit: params.limit,
      order: params.order ?? "asc",
      now: Date.now(),
    }).map((row) => rowToEntry(row, "entries"));
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "entries",
      "PLUGIN_STATE_READ_FAILED",
      "Failed to list plugin state entries by key range.",
    );
  }
}

export function pluginStateClear(params: {
  pluginId: string;
  namespace: string;
  env?: NodeJS.ProcessEnv;
}): void {
  try {
    runWriteTransaction(
      "clear",
      ({ db }) => {
        executeSqliteQuerySync(
          db,
          getPluginStateKysely(db)
            .deleteFrom("plugin_state_entries")
            .where("plugin_id", "=", params.pluginId)
            .where("namespace", "=", params.namespace),
        );
      },
      envOptions(params.env),
    );
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
    return runWriteTransaction("sweep", ({ db }) =>
      sweepExpiredPluginStateEntriesFromDatabase(db, Date.now()),
    );
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
  return cachedDatabase?.db.isOpen === true;
}

export function clearPluginStateDatabaseForTests(): void {
  const store = openPluginStateDatabase("clear");
  executeSqliteQuerySync(
    store.db,
    getPluginStateKysely(store.db).deleteFrom("plugin_state_entries"),
  );
}

function setMaxPluginStateEntriesPerPluginForTests(value?: number): void {
  maxPluginStateEntriesPerPluginForTests = value;
}

export function countPluginStateLiveEntries(pluginId: string, env?: NodeJS.ProcessEnv): number {
  try {
    const { db } = openPluginStateDatabase("entries", envOptions(env));
    return countLivePluginStateEntries(db, { pluginId, now: Date.now() });
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "entries",
      "PLUGIN_STATE_READ_FAILED",
      "Failed to count plugin state entries.",
    );
  }
}

export function getPluginStateCapacity(
  pluginId: string,
  env?: NodeJS.ProcessEnv,
): { liveEntries: number; maxEntries: number } {
  return {
    liveEntries: countPluginStateLiveEntries(pluginId, env),
    maxEntries: resolveMaxPluginStateEntriesPerPlugin(),
  };
}

function seedPluginStateDatabaseEntriesForTests(
  entries: readonly PluginStateSeedEntryForTests[],
): void {
  if (entries.length === 0) {
    return;
  }

  const now = Date.now();
  runWriteTransaction("register", (store) => {
    for (const [index, entry] of entries.entries()) {
      upsertPluginStateEntry(
        store.db,
        bindPluginStateEntry({
          pluginId: entry.pluginId,
          namespace: entry.namespace,
          key: entry.key,
          valueJson: entry.valueJson,
          createdAt: entry.createdAt ?? now + index,
          expiresAt: entry.expiresAt ?? null,
        }),
      );
    }
  });
}

function probePluginStateStore(): PluginStateStoreProbeResult {
  const databasePath = resolveOpenClawStateSqlitePath(process.env);
  const steps: PluginStateStoreProbeStep[] = [];
  const wasOpen = cachedDatabase !== null;
  const stateWasOpen = isOpenClawStateDatabaseOpen();

  const pushOk = (name: string) => steps.push({ name, ok: true });
  const pushFailure = (name: string, error: unknown) => {
    const wrapped =
      error instanceof PluginStateStoreError
        ? error
        : createPluginStateError({
            code: "PLUGIN_STATE_OPEN_FAILED",
            operation: "probe",
            message: error instanceof Error ? error.message : String(error),
            path: databasePath,
            cause: error,
          });
    steps.push({ name, ok: false, code: wrapped.code, message: wrapped.message });
  };

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
        path: databasePath,
        cause: error,
      }),
    );
    return { ok: false, databasePath, steps };
  }

  try {
    openPluginStateDatabase("probe");
    pushOk("open");
    pushOk("schema");
    runWriteTransaction("probe", ({ db }) => {
      const now = Date.now();
      const expiresAt = resolvePluginStateExpiresAtMs({
        ttlMs: 60_000,
        now,
        operation: "probe",
        path: databasePath,
      });
      upsertPluginStateEntry(
        db,
        bindPluginStateEntry({
          pluginId: "core:plugin-state-probe",
          namespace: "diagnostics",
          key: "probe",
          valueJson: JSON.stringify({ ok: true }),
          createdAt: now,
          expiresAt,
        }),
      );
      selectPluginStateEntry(db, {
        pluginId: "core:plugin-state-probe",
        namespace: "diagnostics",
        key: "probe",
        now,
      });
      deletePluginStateEntry(db, {
        pluginId: "core:plugin-state-probe",
        namespace: "diagnostics",
        key: "probe",
      });
    });
    pushOk("write-read-delete");
    openOpenClawStateDatabase().walMaintenance.checkpoint();
    pushOk("checkpoint");
  } catch (error) {
    pushFailure("probe", error);
  } finally {
    if (!wasOpen && !stateWasOpen) {
      closePluginStateDatabase();
    }
  }

  return { ok: steps.every((step) => step.ok), databasePath, steps };
}

export function closePluginStateDatabase(): void {
  cachedDatabase = null;
  closeOpenClawStateDatabase();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.pluginStateSqliteTestApi")] = {
    probePluginStateStore,
    seedPluginStateDatabaseEntriesForTests,
    setMaxPluginStateEntriesPerPluginForTests,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
