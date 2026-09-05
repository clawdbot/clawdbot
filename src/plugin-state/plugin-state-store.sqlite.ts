// Plugin state SQLite helpers persist plugin state in the OpenClaw state database.
import type { DatabaseSync } from "node:sqlite";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import type { Insertable, Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
} from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { isTerminalSqliteIntegrityError } from "../infra/sqlite-integrity.js";
import { coerceRequiredSqliteNumber, normalizeSqliteNumber } from "../infra/sqlite-number.js";
import {
  isSqliteCorruptionError,
  runSqliteImmediateTransactionSync,
} from "../infra/sqlite-transaction.js";
import { isSqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import {
  hasOpenClawStateTablesBeyondStartupCheckpoint,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
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
export const MAX_PLUGIN_STATE_VALUE_BYTES = 1_048_576;
export const MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN = 50_000;
export const MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES = 512;
const PLUGIN_STATE_EXPIRY_BATCH_ROWS = 1_024;
export const PLUGIN_STATE_DOCTOR_IMPORT_BATCH_ROWS = 500;
let maxPluginStateEntriesPerPluginForTests: number | undefined;

type PluginStateEntriesTable = OpenClawStateKyselyDatabase["plugin_state_entries"];
type PluginStateStoreDatabase = Pick<OpenClawStateKyselyDatabase, "plugin_state_entries">;

type PluginStateRow = Selectable<PluginStateEntriesTable>;

export type PluginDoctorRawStateEntry = Omit<PluginStateEntry<unknown>, "value" | "expiresAt"> & {
  valueJson: string;
  value?: unknown;
  expiresAt: number | null;
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
  let publicMessage = message;
  // Only owner-classified failures get public hints. Cause messages can contain
  // database paths, SQL, or stored values and must stay out of this message.
  if (fallbackCode === "PLUGIN_STATE_OPEN_FAILED") {
    if (isSqliteSchemaVersionError(error)) {
      publicMessage +=
        "\nThe state database uses a newer schema. Run an OpenClaw build that supports it.";
    } else if (error instanceof Error && isTerminalSqliteIntegrityError(error)) {
      publicMessage +=
        "\nDatabase integrity verification failed. Restore or repair the state database, then run openclaw doctor --fix.";
    }
  }
  return createPluginStateError({
    code: fallbackCode,
    operation,
    message: publicMessage,
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

type PluginStateEntryLookup = { pluginId: string; namespace: string; key: string; now: number };
const pluginStateEntryQueries = new WeakMap<
  DatabaseSync,
  ReturnType<typeof prepareSqliteQuerySync<PluginStateEntryLookup, PluginStateRow>>
>();

function selectPluginStateEntry(
  db: DatabaseSync,
  params: PluginStateEntryLookup,
): PluginStateRow | undefined {
  let query = pluginStateEntryQueries.get(db);
  if (!query) {
    // Retain compilation with the physical connection; keys and expiry stay invocation-local.
    query = prepareSqliteQuerySync<PluginStateEntryLookup, PluginStateRow>(db, (parameter) => {
      const pluginId = parameter((value) => value.pluginId);
      const namespace = parameter((value) => value.namespace);
      const key = parameter((value) => value.key);
      const now = parameter((value) => value.now);
      return getPluginStateKysely(db)
        .selectFrom("plugin_state_entries")
        .select(["plugin_id", "namespace", "entry_key", "value_json", "created_at", "expires_at"])
        .where("plugin_id", "=", pluginId)
        .where("namespace", "=", namespace)
        .where("entry_key", "=", key)
        .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]));
    });
    pluginStateEntryQueries.set(db, query);
  }
  return query(params).rows[0];
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

function deleteExpiredPluginStateEntries(
  db: DatabaseSync,
  now: number,
  scope?: { pluginId: string; namespace: string },
): number {
  const kysely = getPluginStateKysely(db);
  let expiredEntries = kysely
    .selectFrom("plugin_state_entries")
    .select(["plugin_id", "namespace", "entry_key"])
    .where("expires_at", "is not", null)
    .where("expires_at", "<=", now);
  // Global expiry ordering uses its index; namespace scans must stay unsorted
  // so SQLite never builds an unbounded temporary sort under the write lock.
  expiredEntries = scope
    ? expiredEntries
        .where("plugin_id", "=", scope.pluginId)
        .where("namespace", "=", scope.namespace)
    : expiredEntries.orderBy("expires_at", "asc");
  const result = executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("plugin_state_entries")
      .where((expression) =>
        expression(
          expression.refTuple("plugin_id", "namespace", "entry_key"),
          "in",
          expiredEntries
            .limit(PLUGIN_STATE_EXPIRY_BATCH_ROWS)
            .$asTuple("plugin_id", "namespace", "entry_key"),
        ),
      ),
  );
  return Number(result.numAffectedRows ?? 0);
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
  return coerceRequiredSqliteNumber(row?.count ?? 0);
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
  return coerceRequiredSqliteNumber(row?.count ?? 0);
}

function deleteOldestPluginStateNamespaceEntries(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; protectedKey: string; now: number; limit: number },
): number {
  const kysely = getPluginStateKysely(db);
  const keys = kysely
    .selectFrom("plugin_state_entries")
    .select("entry_key")
    .where("plugin_id", "=", params.pluginId)
    .where("namespace", "=", params.namespace)
    .where("entry_key", "!=", params.protectedKey)
    .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", params.now)]))
    .orderBy("created_at", "asc")
    .orderBy("entry_key", "asc")
    .limit(params.limit);
  const result = executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("plugin_state_entries")
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where("entry_key", "in", keys),
  );
  return Number(result.numAffectedRows ?? 0);
}

function openPluginStateDatabase(
  operation: PluginStateStoreOperation = "open",
  options: OpenClawStateDatabaseOptions = {},
): PluginStateDatabase {
  const env = options.env ?? process.env;
  const pathname = resolveOpenClawStateSqlitePath(env);
  try {
    return openOpenClawStateDatabase(options);
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

function isMissingPluginStateTableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR" &&
    error.message === "no such table: plugin_state_entries"
  );
}

/** Read plugin state without joining the shared writable database lifecycle. */
function withPluginStateDatabaseReadOnly<T>(
  operationName: PluginStateStoreOperation,
  operation: (store: PluginStateDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): T | undefined {
  const pathname = resolveOpenClawStateSqlitePath(options.env ?? process.env);
  let operationStarted = false;
  try {
    return withExistingOpenClawStateDatabaseReadOnly(({ db, path }) => {
      operationStarted = true;
      try {
        return operation({ db, path });
      } catch (error) {
        if (isMissingPluginStateTableError(error)) {
          // The lease bootstrap creates exactly schema_meta + state_leases before the first write;
          // any other table means the missing plugin-state table is damage, not fresh state.
          if (!hasOpenClawStateTablesBeyondStartupCheckpoint(db)) {
            return undefined;
          }
        }
        throw error;
      }
    }, options);
  } catch (error) {
    if (!operationStarted) {
      throw wrapPluginStateError(
        error,
        operationName,
        "PLUGIN_STATE_OPEN_FAILED",
        "Failed to open the plugin state database.",
        pathname,
      );
    }
    throw error;
  }
}

function envOptions(env?: NodeJS.ProcessEnv): OpenClawStateDatabaseOptions {
  return env ? { env } : {};
}

function runWriteTransaction<T>(
  operation: PluginStateStoreOperation,
  write: (store: PluginStateDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): T {
  // Only cold acquisition failures are open errors. A held owner's ownership or
  // transaction failure must remain a write error, with its callback supplying the handle.
  if (!isOpenClawStateDatabaseOpen(resolveOpenClawStateSqlitePath(options.env ?? process.env))) {
    openPluginStateDatabase(operation, options);
  }
  return runOpenClawStateWriteTransaction(write, options);
}

type PluginStateRetention = {
  namespaceCount: number;
  pluginCount: number;
  nextExpiry: number;
  now: number;
  sweepPending: boolean;
};

function readPluginStateRetention(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; now: number },
): PluginStateRetention {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getPluginStateKysely(db)
      .selectFrom("plugin_state_entries")
      .select((eb) => [
        eb.fn.countAll<number | bigint>().as("plugin_count"),
        eb.fn
          .countAll<number | bigint>()
          .filterWhere("namespace", "=", params.namespace)
          .as("namespace_count"),
        eb.fn.min<number | bigint | null>("expires_at").as("next_expiry"),
      ])
      .where("plugin_id", "=", params.pluginId)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", params.now)])),
  );
  return {
    namespaceCount: coerceRequiredSqliteNumber(row?.namespace_count ?? 0),
    pluginCount: coerceRequiredSqliteNumber(row?.plugin_count ?? 0),
    nextExpiry: normalizeSqliteNumber(row?.next_expiry ?? null) ?? Infinity,
    now: params.now,
    sweepPending: true,
  };
}

function enforcePostRegisterLimits(params: {
  store: PluginStateDatabase;
  pluginId: string;
  namespace: string;
  maxEntries: number;
  overflowPolicy: PluginStateOverflowPolicy;
  now: number;
  retention?: PluginStateRetention;
  protectedKey: string;
  enforcePluginLimit?: boolean;
}): void {
  if (params.overflowPolicy === "reject-new") {
    return;
  }
  const namespaceCount =
    params.retention?.namespaceCount ??
    countLivePluginStateNamespaceEntries(params.store.db, {
      pluginId: params.pluginId,
      namespace: params.namespace,
      now: params.now,
    });
  if (namespaceCount > params.maxEntries) {
    const deleted = deleteOldestPluginStateNamespaceEntries(params.store.db, {
      pluginId: params.pluginId,
      namespace: params.namespace,
      protectedKey: params.protectedKey,
      now: params.now,
      limit: namespaceCount - params.maxEntries,
    });
    if (params.retention) {
      params.retention.namespaceCount -= deleted;
      params.retention.pluginCount -= deleted;
    }
  }

  if (params.enforcePluginLimit === false) {
    return;
  }

  const pluginCount =
    params.retention?.pluginCount ??
    countLivePluginStateEntries(params.store.db, {
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
  const deleted = deleteOldestPluginStateNamespaceEntries(params.store.db, {
    pluginId: params.pluginId,
    namespace: params.namespace,
    protectedKey: params.protectedKey,
    now: params.now,
    limit: pluginCount - maxPluginEntries,
  });
  if (params.retention) {
    params.retention.namespaceCount -= deleted;
    params.retention.pluginCount -= deleted;
  }
  const remainingPluginCount =
    params.retention?.pluginCount ??
    countLivePluginStateEntries(params.store.db, {
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
  retention?: PluginStateRetention;
}): void {
  if (params.overflowPolicy !== "reject-new") {
    return;
  }
  const namespaceCount =
    params.retention?.namespaceCount ??
    countLivePluginStateNamespaceEntries(params.store.db, {
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
  const pluginCount =
    params.retention?.pluginCount ??
    countLivePluginStateEntries(params.store.db, {
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

type PluginStateRegisterParams = {
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
};

function registerPluginStateEntry(
  store: PluginStateDatabase,
  params: PluginStateRegisterParams,
  retention?: PluginStateRetention,
): void {
  const now = Date.now();
  const expiresAt = resolvePluginStateExpiresAtMs({
    ttlMs: params.ttlMs,
    now,
    operation: "register",
    path: store.path,
  });
  // Counts belong to this transaction. Expiry (including sibling rows) or a
  // backward clock invalidates them; ordinary writes update them incrementally.
  if (retention && (now < retention.now || now >= retention.nextExpiry)) {
    Object.assign(retention, readPluginStateRetention(store.db, { ...params, now }));
  }
  if (!retention || retention.sweepPending) {
    const deleted = deleteExpiredPluginStateEntries(store.db, now, params);
    if (retention) {
      retention.sweepPending = deleted === PLUGIN_STATE_EXPIRY_BATCH_ROWS;
    }
  }
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
      retention,
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
  if (retention) {
    if (!existing) {
      retention.namespaceCount += 1;
      retention.pluginCount += 1;
    }
    retention.nextExpiry = Math.min(retention.nextExpiry, expiresAt ?? Infinity);
    retention.now = now;
  }
  enforcePostRegisterLimits({
    store,
    pluginId: params.pluginId,
    namespace: params.namespace,
    maxEntries: params.maxEntries,
    overflowPolicy: params.overflowPolicy,
    now,
    protectedKey: params.key,
    retention,
  });
}

export function pluginStateRegister(params: PluginStateRegisterParams): void {
  try {
    runWriteTransaction(
      "register",
      (store) => registerPluginStateEntry(store, params),
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

/** Prepared doctor rows only: validation and plugin-owned accessors run before BEGIN. */
export function pluginStateImportBatch(
  params: Pick<
    PluginStateRegisterParams,
    "pluginId" | "namespace" | "maxEntries" | "overflowPolicy" | "env"
  >,
  entries: readonly Pick<
    PluginStateRegisterParams,
    "key" | "valueJson" | "createdAtMs" | "ttlMs"
  >[],
): void {
  if (entries.length === 0) {
    return;
  }
  if (entries.length > PLUGIN_STATE_DOCTOR_IMPORT_BATCH_ROWS) {
    throw new RangeError("Plugin state doctor import batch exceeds its row limit");
  }
  try {
    const result = runWriteTransaction(
      "register",
      (store): Result<void, unknown> => {
        const retention = readPluginStateRetention(store.db, { ...params, now: Date.now() });
        for (const entry of entries) {
          try {
            // A row can evict before failing. Roll back only that row, then commit
            // the successful prefix before reporting failure so Doctor can resume.
            runSqliteImmediateTransactionSync(store.db, () =>
              registerPluginStateEntry(store, { ...params, ...entry }, retention),
            );
          } catch (error) {
            // Corruption must reach the shared database owner so it evicts the
            // damaged handle; an unsafe transaction cannot commit its prefix.
            if (isSqliteCorruptionError(error)) {
              throw error;
            }
            return err(error);
          }
        }
        return ok(undefined);
      },
      envOptions(params.env),
    );
    if (!result.ok) {
      throw result.error;
    }
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
        deleteExpiredPluginStateEntries(store.db, now, {
          pluginId: params.pluginId,
          namespace: params.cursorNamespace,
        });
        deleteExpiredPluginStateEntries(store.db, now, {
          pluginId: params.pluginId,
          namespace: params.journalNamespace,
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
        deleteExpiredPluginStateEntries(store.db, now, {
          pluginId: params.pluginId,
          namespace: params.namespace,
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
        // The exact expired key can lie beyond this namespace's cleanup batch.
        // Reclaim it inside the same authoritative transaction before insertion.
        deletePluginStateEntry(store.db, params);
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
        deleteExpiredPluginStateEntries(store.db, now, {
          pluginId: params.pluginId,
          namespace: params.namespace,
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
  const pathname = resolveOpenClawStateSqlitePath(params.env ?? process.env);
  try {
    return withPluginStateDatabaseReadOnly(
      "lookup",
      ({ db }) => {
        const row = selectPluginStateEntry(db, {
          pluginId: params.pluginId,
          namespace: params.namespace,
          key: params.key,
          now: Date.now(),
        });
        return row ? parseStoredJson(row.value_json, "lookup") : undefined;
      },
      envOptions(params.env),
    );
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "lookup",
      "PLUGIN_STATE_READ_FAILED",
      "Failed to read plugin state entry.",
      pathname,
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

/** Deletes one bounded set of exact observed rows in a single synchronous transaction. */
export function pluginStateDeleteEntriesIfUnchanged(params: {
  pluginId: string;
  namespace: string;
  entries: readonly PluginDoctorRawStateEntry[];
  assertOwnedInTransaction: (database: DatabaseSync) => void;
  env?: NodeJS.ProcessEnv;
}): { deleted: number; changed: number } {
  if (params.entries.length > MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES) {
    throw new RangeError(
      `Plugin state bulk deletion cannot exceed ${MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES} entries.`,
    );
  }
  if (params.entries.length === 0) {
    return { deleted: 0, changed: 0 };
  }
  // Copy plugin-visible envelopes before BEGIN; no plugin-owned accessors run in the transaction.
  const observed = params.entries.map(({ value: _value, ...entry }) => entry);
  return runWriteTransaction(
    "delete",
    ({ db }) => {
      params.assertOwnedInTransaction(db);
      let deleted = 0;
      for (const entry of observed) {
        let query = getPluginStateKysely(db)
          .deleteFrom("plugin_state_entries")
          .where("plugin_id", "=", params.pluginId)
          .where("namespace", "=", params.namespace)
          .where("entry_key", "=", entry.key)
          .where("value_json", "=", entry.valueJson)
          .where("created_at", "=", entry.createdAt);
        query =
          entry.expiresAt === null
            ? query.where("expires_at", "is", null)
            : query.where("expires_at", "=", entry.expiresAt);
        deleted += Number(executeSqliteQuerySync(db, query).numAffectedRows ?? 0);
      }
      return { deleted, changed: observed.length - deleted };
    },
    envOptions(params.env),
  );
}

/** Doctor-only bounded raw read keeps malformed rows visible and preserves exact CAS bytes. */
export function pluginStateDoctorEntriesInKeyRange(params: {
  pluginId: string;
  namespace: string;
  prefix: string;
  after?: string;
  limit: number;
  env?: NodeJS.ProcessEnv;
}): PluginDoctorRawStateEntry[] {
  if (
    !params.prefix ||
    !Number.isSafeInteger(params.limit) ||
    params.limit < 1 ||
    params.limit > MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES ||
    (params.after !== undefined && !params.after.startsWith(params.prefix))
  ) {
    throw new RangeError(
      `Plugin doctor state reads require a valid prefix and a limit of 1-${MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES}.`,
    );
  }
  return readPluginStateRowsInKeyRange(
    {
      ...params,
      keyStartInclusive: params.after === undefined ? params.prefix : `${params.after}\0`,
      keyEndExclusive: `${params.prefix}\uffff`,
    },
    (row): PluginDoctorRawStateEntry => {
      const createdAt = normalizeSqliteNumber(row.created_at);
      const expiresAt = normalizeSqliteNumber(row.expires_at);
      const entry: PluginDoctorRawStateEntry = {
        key: row.entry_key,
        valueJson: row.value_json,
        createdAt: createdAt ?? 0,
        expiresAt: expiresAt ?? null,
      };
      if (
        !Number.isSafeInteger(createdAt) ||
        (createdAt ?? -1) < 0 ||
        (row.expires_at !== null && !Number.isSafeInteger(expiresAt))
      ) {
        return entry;
      }
      try {
        entry.value = JSON.parse(row.value_json) as unknown;
      } catch {
        // Keep corrupt rows in the page so Doctor can advance past them safely.
      }
      return entry;
    },
  );
}

export function pluginStateEntries(params: {
  pluginId: string;
  namespace: string;
  env?: NodeJS.ProcessEnv;
}): PluginStateEntry<unknown>[] {
  const pathname = resolveOpenClawStateSqlitePath(params.env ?? process.env);
  try {
    return (
      withPluginStateDatabaseReadOnly(
        "entries",
        ({ db }) => {
          const rows = selectPluginStateEntries(db, {
            pluginId: params.pluginId,
            namespace: params.namespace,
            now: Date.now(),
          });
          return rows.map((row) => rowToEntry(row, "entries"));
        },
        envOptions(params.env),
      ) ?? []
    );
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "entries",
      "PLUGIN_STATE_READ_FAILED",
      "Failed to list plugin state entries.",
      pathname,
    );
  }
}

/** Internal bounded key-range read for core owners with sortable plugin-state keys. */
type PluginStateKeyRangeParams = {
  pluginId: string;
  namespace: string;
  keyStartInclusive: string;
  keyEndExclusive: string;
  limit: number;
  order?: "asc" | "desc";
  env?: NodeJS.ProcessEnv;
};

export function pluginStateEntriesInKeyRange(
  params: PluginStateKeyRangeParams,
): PluginStateEntry<unknown>[] {
  return readPluginStateRowsInKeyRange(params, (row) => rowToEntry(row, "entries"));
}

function readPluginStateRowsInKeyRange<T>(
  params: PluginStateKeyRangeParams,
  mapRow: (row: PluginStateRow) => T,
): T[] {
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
  const pathname = resolveOpenClawStateSqlitePath(params.env ?? process.env);
  try {
    return (
      withPluginStateDatabaseReadOnly(
        "entries",
        ({ db }) =>
          selectPluginStateEntriesInKeyRange(db, {
            pluginId: params.pluginId,
            namespace: params.namespace,
            keyStartInclusive: params.keyStartInclusive,
            keyEndExclusive: params.keyEndExclusive,
            limit: params.limit,
            order: params.order ?? "asc",
            now: Date.now(),
          }).map(mapRow),
        envOptions(params.env),
      ) ?? []
    );
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "entries",
      "PLUGIN_STATE_READ_FAILED",
      "Failed to list plugin state entries by key range.",
      pathname,
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
      deleteExpiredPluginStateEntries(db, Date.now()),
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
  const pathname = resolveOpenClawStateSqlitePath(env ?? process.env);
  try {
    return (
      withPluginStateDatabaseReadOnly(
        "entries",
        ({ db }) => countLivePluginStateEntries(db, { pluginId, now: Date.now() }),
        envOptions(env),
      ) ?? 0
    );
  } catch (error) {
    throw wrapPluginStateError(
      error,
      "entries",
      "PLUGIN_STATE_READ_FAILED",
      "Failed to count plugin state entries.",
      pathname,
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
    if (!stateWasOpen) {
      closePluginStateDatabase();
    }
  }

  return { ok: steps.every((step) => step.ok), databasePath, steps };
}

export function closePluginStateDatabase(): void {
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
