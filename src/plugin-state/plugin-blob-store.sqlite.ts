// SQLite persistence for plugin-owned byte blobs and JSON metadata.
import type { DatabaseSync } from "node:sqlite";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import type { Insertable, Selectable } from "kysely";
import { hasErrnoCode } from "../infra/errno.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import {
  coerceRequiredSqliteNumber as sqliteNumber,
  normalizeSqliteNumber,
} from "../infra/sqlite-number.js";
import {
  hasOpenClawStateTablesBeyondStartupCheckpoint,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type {
  PluginBlobEntry,
  PluginBlobEntryInfo,
  PluginBlobOverflowPolicy,
  PluginBlobStoreErrorCode,
  PluginBlobStoreOperation,
} from "./plugin-blob-store.types.js";
import { PluginBlobStoreError } from "./plugin-blob-store.types.js";

export const MAX_PLUGIN_BLOB_BYTES_PER_ENTRY = 100 * 1024 * 1024;
export const MAX_PLUGIN_BLOB_BYTES_PER_PLUGIN = 512 * 1024 * 1024;
export const MAX_PLUGIN_BLOB_ENTRIES_PER_PLUGIN = 50_000;

type PluginBlobTable = OpenClawStateKyselyDatabase["plugin_blob_entries"];
type PluginBlobDatabase = Pick<OpenClawStateKyselyDatabase, "plugin_blob_entries">;
type PluginBlobRow = Selectable<PluginBlobTable>;

type PluginBlobStoredInfo = Pick<
  PluginBlobRow,
  "entry_key" | "metadata_json" | "created_at" | "expires_at"
> & { size_bytes: number | bigint };

type BlobUsage = {
  namespaceCount: number;
  namespaceBytes: number;
  pluginCount: number;
  pluginBytes: number;
};

type BlobWriteParams = {
  pluginId: string;
  namespace: string;
  key: string;
  bytes: Uint8Array;
  metadataJson: string;
  maxEntries: number;
  maxBytesPerNamespace: number;
  overflowPolicy: PluginBlobOverflowPolicy;
  ttlMs?: number;
  env?: NodeJS.ProcessEnv;
};

function createError(params: {
  code: PluginBlobStoreErrorCode;
  operation: PluginBlobStoreOperation;
  message: string;
  env?: NodeJS.ProcessEnv;
  cause?: unknown;
}): PluginBlobStoreError {
  return new PluginBlobStoreError(params.message, {
    code: params.code,
    operation: params.operation,
    path: resolveOpenClawStateSqlitePath(params.env ?? process.env),
    cause: params.cause,
  });
}

function wrapError(
  error: unknown,
  operation: PluginBlobStoreOperation,
  fallbackCode: PluginBlobStoreErrorCode,
  message: string,
  env?: NodeJS.ProcessEnv,
): PluginBlobStoreError {
  return error instanceof PluginBlobStoreError
    ? error
    : createError({ code: fallbackCode, operation, message, env, cause: error });
}

function openDatabase(operation: PluginBlobStoreOperation, env?: NodeJS.ProcessEnv) {
  try {
    const database = openOpenClawStateDatabase(env ? { env } : {});
    return database;
  } catch (error) {
    throw wrapError(
      error,
      operation,
      "PLUGIN_BLOB_OPEN_FAILED",
      "Failed to open plugin blob store.",
      env,
    );
  }
}

function readDatabase<T>(
  operation: "lookup" | "entries",
  read: (db: DatabaseSync) => T,
  env?: NodeJS.ProcessEnv,
): T | undefined {
  let readStarted = false;
  try {
    return withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => {
        readStarted = true;
        try {
          return read(db);
        } catch (error) {
          if (
            error instanceof Error &&
            hasErrnoCode(error, "ERR_SQLITE_ERROR") &&
            error.message === "no such table: plugin_blob_entries" &&
            !hasOpenClawStateTablesBeyondStartupCheckpoint(db)
          ) {
            return undefined;
          }
          throw error;
        }
      },
      env ? { env } : {},
    );
  } catch (error) {
    throw wrapError(
      error,
      operation,
      readStarted ? "PLUGIN_BLOB_READ_FAILED" : "PLUGIN_BLOB_OPEN_FAILED",
      readStarted
        ? operation === "lookup"
          ? "Failed to read plugin blob entry."
          : "Failed to list plugin blob entries."
        : "Failed to open plugin blob store.",
      env,
    );
  }
}

function kysely(db: DatabaseSync) {
  return getNodeSqliteKysely<PluginBlobDatabase>(db);
}

function decodeBlobInfo<TMetadata>(
  row: PluginBlobStoredInfo,
  operation: PluginBlobStoreOperation,
  env?: NodeJS.ProcessEnv,
): PluginBlobEntryInfo<TMetadata> {
  let metadata: TMetadata;
  try {
    // SAFETY: The typed plugin namespace owns the metadata shape; storage validates JSON syntax.
    metadata = JSON.parse(row.metadata_json) as TMetadata;
  } catch (error) {
    throw createError({
      code: "PLUGIN_BLOB_CORRUPT",
      operation,
      message: "Plugin blob entry contains corrupt metadata JSON.",
      env,
      cause: error,
    });
  }
  const expiresAt = normalizeSqliteNumber(row.expires_at);
  return {
    key: row.entry_key,
    metadata,
    sizeBytes: sqliteNumber(row.size_bytes),
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    ...(expiresAt != null ? { expiresAt } : {}),
  };
}

function selectLiveBlob(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; key: string; now: number },
) {
  return executeSqliteQueryTakeFirstSync(
    db,
    kysely(db)
      .selectFrom("plugin_blob_entries")
      .select(["entry_key", "metadata_json", "blob", "created_at", "expires_at"])
      .select((eb) => eb.fn<number | bigint>("length", ["blob"]).as("size_bytes"))
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where("entry_key", "=", params.key)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", params.now)])),
  );
}

function blobKeyExists(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; key: string },
): boolean {
  return (
    executeSqliteQueryTakeFirstSync(
      db,
      kysely(db)
        .selectFrom("plugin_blob_entries")
        .select("entry_key")
        .where("plugin_id", "=", params.pluginId)
        .where("namespace", "=", params.namespace)
        .where("entry_key", "=", params.key),
    ) !== undefined
  );
}

function selectLiveInfo(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; now: number },
): PluginBlobStoredInfo[] {
  return executeSqliteQuerySync(
    db,
    kysely(db)
      .selectFrom("plugin_blob_entries")
      .select(["entry_key", "metadata_json", "created_at", "expires_at"])
      .select((eb) => eb.fn<number | bigint>("length", ["blob"]).as("size_bytes"))
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", params.now)]))
      .orderBy("created_at", "asc")
      .orderBy("entry_key", "asc"),
  ).rows;
}

function selectExpiredKeyInfo(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; key: string; now: number },
): PluginBlobStoredInfo | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    kysely(db)
      .selectFrom("plugin_blob_entries")
      .select(["entry_key", "metadata_json", "created_at", "expires_at"])
      .select((eb) => eb.fn<number | bigint>("length", ["blob"]).as("size_bytes"))
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where("entry_key", "=", params.key)
      .where("expires_at", "is not", null)
      .where("expires_at", "<=", params.now),
  );
}

function selectEvictionCandidates(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; key: string; now: number },
) {
  return executeSqliteQuerySync(
    db,
    kysely(db)
      .selectFrom("plugin_blob_entries")
      .select("entry_key")
      .select((eb) => eb.fn<number | bigint>("length", ["blob"]).as("size_bytes"))
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where("entry_key", "!=", params.key)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", params.now)]))
      .orderBy("created_at", "asc")
      .orderBy("entry_key", "asc"),
  ).rows;
}

function readStoredUsage(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string },
): BlobUsage {
  // Expired rows retain cleanup metadata, so physical accounting includes them.
  const row = executeSqliteQueryTakeFirstSync(
    db,
    kysely(db)
      .selectFrom("plugin_blob_entries")
      .select((eb) => [
        eb.fn.countAll<number | bigint>().as("plugin_count"),
        eb.fn
          .countAll<number | bigint>()
          .filterWhere("namespace", "=", params.namespace)
          .as("namespace_count"),
        eb.fn.sum<number | bigint | null>(eb.fn("length", ["blob"])).as("plugin_bytes"),
        eb.fn
          .sum<number | bigint | null>(eb.fn("length", ["blob"]))
          .filterWhere("namespace", "=", params.namespace)
          .as("namespace_bytes"),
      ])
      .where("plugin_id", "=", params.pluginId),
  );
  return {
    namespaceCount: sqliteNumber(row?.namespace_count ?? 0),
    namespaceBytes: sqliteNumber(row?.namespace_bytes ?? 0),
    pluginCount: sqliteNumber(row?.plugin_count ?? 0),
    pluginBytes: sqliteNumber(row?.plugin_bytes ?? 0),
  };
}

function readStoredKeySize(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; key: string },
): number | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    kysely(db)
      .selectFrom("plugin_blob_entries")
      .select((eb) => eb.fn<number | bigint>("length", ["blob"]).as("size_bytes"))
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where("entry_key", "=", params.key),
  );
  return row ? sqliteNumber(row.size_bytes) : undefined;
}

function deleteKey(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; key: string },
): number {
  const result = executeSqliteQuerySync(
    db,
    kysely(db)
      .deleteFrom("plugin_blob_entries")
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where("entry_key", "=", params.key),
  );
  return Number(result.numAffectedRows ?? 0);
}

function deleteKeys(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; keys: readonly string[] },
): void {
  // Stay below conservative SQLite bind-variable limits while avoiding one
  // DELETE and one array rebuild per evicted row inside the write transaction.
  const batchSize = 500;
  for (let offset = 0; offset < params.keys.length; offset += batchSize) {
    const keys = params.keys.slice(offset, offset + batchSize);
    executeSqliteQuerySync(
      db,
      kysely(db)
        .deleteFrom("plugin_blob_entries")
        .where("plugin_id", "=", params.pluginId)
        .where("namespace", "=", params.namespace)
        .where("entry_key", "in", keys),
    );
  }
}

function deleteExpiredNamespace(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; now: number },
): number {
  const result = executeSqliteQuerySync(
    db,
    kysely(db)
      .deleteFrom("plugin_blob_entries")
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where("expires_at", "is not", null)
      .where("expires_at", "<=", params.now),
  );
  return Number(result.numAffectedRows ?? 0);
}

function limitError(message: string, env?: NodeJS.ProcessEnv): PluginBlobStoreError {
  return createError({
    code: "PLUGIN_BLOB_LIMIT_EXCEEDED",
    operation: "register",
    message,
    env,
  });
}

function assertProjectedLimits(params: {
  db: DatabaseSync;
  write: BlobWriteParams;
  existingBytes?: number;
}): void {
  const usage = readStoredUsage(params.db, params.write);
  const previousBytes = params.existingBytes ?? 0;
  const rowDelta = params.existingBytes === undefined ? 1 : 0;
  if (usage.namespaceCount + rowDelta > params.write.maxEntries) {
    throw limitError("Plugin blob namespace reached its stored row limit.", params.write.env);
  }
  if (
    usage.namespaceBytes - previousBytes + params.write.bytes.byteLength >
    params.write.maxBytesPerNamespace
  ) {
    throw limitError("Plugin blob namespace reached its stored byte limit.", params.write.env);
  }
  if (usage.pluginCount + rowDelta > MAX_PLUGIN_BLOB_ENTRIES_PER_PLUGIN) {
    throw limitError("Plugin blob store reached its per-plugin row limit.", params.write.env);
  }
  if (
    usage.pluginBytes - previousBytes + params.write.bytes.byteLength >
    MAX_PLUGIN_BLOB_BYTES_PER_PLUGIN
  ) {
    throw limitError("Plugin blob store reached its per-plugin byte limit.", params.write.env);
  }
}

function deleteOldestUntilWithinLimits(params: {
  db: DatabaseSync;
  write: BlobWriteParams;
  now: number;
}): void {
  const usage = readStoredUsage(params.db, params.write);
  const withinLimits = () =>
    usage.namespaceCount <= params.write.maxEntries &&
    usage.namespaceBytes <= params.write.maxBytesPerNamespace &&
    usage.pluginCount <= MAX_PLUGIN_BLOB_ENTRIES_PER_PLUGIN &&
    usage.pluginBytes <= MAX_PLUGIN_BLOB_BYTES_PER_PLUGIN;
  if (withinLimits()) {
    return;
  }
  // Only this namespace's live rows may be evicted. Expired rows still own
  // external cleanup, and sibling namespaces never pay for this write.
  const candidates = selectEvictionCandidates(params.db, {
    pluginId: params.write.pluginId,
    namespace: params.write.namespace,
    now: params.now,
    key: params.write.key,
  });
  const keysToDelete: string[] = [];
  for (const row of candidates) {
    keysToDelete.push(row.entry_key);
    const sizeBytes = sqliteNumber(row.size_bytes);
    usage.namespaceCount -= 1;
    usage.namespaceBytes -= sizeBytes;
    usage.pluginCount -= 1;
    usage.pluginBytes -= sizeBytes;
    if (withinLimits()) {
      break;
    }
  }
  if (
    usage.namespaceCount > params.write.maxEntries ||
    usage.namespaceBytes > params.write.maxBytesPerNamespace
  ) {
    throw limitError(
      "Plugin blob namespace cannot satisfy its configured limits.",
      params.write.env,
    );
  }
  if (
    usage.pluginCount > MAX_PLUGIN_BLOB_ENTRIES_PER_PLUGIN ||
    usage.pluginBytes > MAX_PLUGIN_BLOB_BYTES_PER_PLUGIN
  ) {
    throw limitError("Plugin blob store cannot satisfy its per-plugin limits.", params.write.env);
  }
  deleteKeys(params.db, {
    pluginId: params.write.pluginId,
    namespace: params.write.namespace,
    keys: keysToDelete,
  });
}

function upsertBlob(db: DatabaseSync, params: BlobWriteParams, now: number): void {
  const expiresAt = (() => {
    if (params.ttlMs === undefined) {
      return null;
    }
    const resolved = resolveExpiresAtMsFromDurationMs(params.ttlMs, { nowMs: now });
    if (resolved === undefined) {
      throw createError({
        code: "PLUGIN_BLOB_INVALID_INPUT",
        operation: "register",
        message: "Plugin blob ttlMs cannot produce a valid expiry timestamp.",
        env: params.env,
      });
    }
    return resolved;
  })();
  const row: Insertable<PluginBlobTable> = {
    plugin_id: params.pluginId,
    namespace: params.namespace,
    entry_key: params.key,
    metadata_json: params.metadataJson,
    blob: params.bytes,
    created_at: now,
    expires_at: expiresAt,
  };
  executeSqliteQuerySync(
    db,
    kysely(db)
      .insertInto("plugin_blob_entries")
      .values(row)
      .onConflict((conflict) =>
        conflict.columns(["plugin_id", "namespace", "entry_key"]).doUpdateSet({
          metadata_json: (eb) => eb.ref("excluded.metadata_json"),
          blob: (eb) => eb.ref("excluded.blob"),
          created_at: (eb) => eb.ref("excluded.created_at"),
          expires_at: (eb) => eb.ref("excluded.expires_at"),
        }),
      ),
  );
}

function writeBlob(params: BlobWriteParams, ifAbsent: boolean): boolean {
  try {
    openDatabase("register", params.env);
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const now = Date.now();
        if (ifAbsent && blobKeyExists(db, params)) {
          // Expired rows remain owner-managed until explicitly claimed. Treat
          // them as occupied so stable-key reuse cannot discard cleanup metadata.
          return false;
        }
        if (params.overflowPolicy === "reject-new") {
          const existingBytes = ifAbsent ? undefined : readStoredKeySize(db, params);
          assertProjectedLimits({ db, write: params, existingBytes });
        }
        upsertBlob(db, params, now);
        if (params.overflowPolicy === "evict-oldest") {
          deleteOldestUntilWithinLimits({ db, write: params, now });
        }
        return true;
      },
      params.env ? { env: params.env } : {},
    );
  } catch (error) {
    throw wrapError(
      error,
      "register",
      "PLUGIN_BLOB_WRITE_FAILED",
      "Failed to register plugin blob entry.",
      params.env,
    );
  }
}

export function pluginBlobRegister(params: BlobWriteParams): void {
  writeBlob(params, false);
}

export function pluginBlobRegisterIfAbsent(params: BlobWriteParams): boolean {
  return writeBlob(params, true);
}

export function pluginBlobLookup<TMetadata>(params: {
  pluginId: string;
  namespace: string;
  key: string;
  env?: NodeJS.ProcessEnv;
}): PluginBlobEntry<TMetadata> | undefined {
  return readDatabase(
    "lookup",
    (db) => {
      const row = selectLiveBlob(db, { ...params, now: Date.now() });
      return row
        ? {
            ...decodeBlobInfo<TMetadata>(row, "lookup", params.env),
            bytes: Uint8Array.from(row.blob),
          }
        : undefined;
    },
    params.env,
  );
}

export function pluginBlobEntries<TMetadata>(params: {
  pluginId: string;
  namespace: string;
  env?: NodeJS.ProcessEnv;
}): PluginBlobEntryInfo<TMetadata>[] {
  return (
    readDatabase(
      "entries",
      (db) =>
        selectLiveInfo(db, { ...params, now: Date.now() }).map((row) =>
          decodeBlobInfo<TMetadata>(row, "entries", params.env),
        ),
      params.env,
    ) ?? []
  );
}

export function pluginBlobDelete(params: {
  pluginId: string;
  namespace: string;
  key: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  try {
    openDatabase("delete", params.env);
    return runOpenClawStateWriteTransaction(
      ({ db }) => deleteKey(db, params) > 0,
      params.env ? { env: params.env } : {},
    );
  } catch (error) {
    throw wrapError(
      error,
      "delete",
      "PLUGIN_BLOB_WRITE_FAILED",
      "Failed to delete plugin blob entry.",
      params.env,
    );
  }
}

export function pluginBlobDeleteExpiredKey<TMetadata>(params: {
  pluginId: string;
  namespace: string;
  key: string;
  env?: NodeJS.ProcessEnv;
}): PluginBlobEntryInfo<TMetadata> | undefined {
  try {
    openDatabase("sweep", params.env);
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const row = selectExpiredKeyInfo(db, { ...params, now: Date.now() });
        if (!row) {
          return undefined;
        }
        // Decode before deletion so corrupt metadata cannot orphan external artifacts.
        const entry = decodeBlobInfo<TMetadata>(row, "sweep", params.env);
        deleteKey(db, params);
        return entry;
      },
      params.env ? { env: params.env } : {},
    );
  } catch (error) {
    throw wrapError(
      error,
      "sweep",
      "PLUGIN_BLOB_WRITE_FAILED",
      "Failed to delete expired plugin blob.",
      params.env,
    );
  }
}

export function pluginBlobDeleteExpired<TMetadata>(params: {
  pluginId: string;
  namespace: string;
  env?: NodeJS.ProcessEnv;
}): PluginBlobEntryInfo<TMetadata>[] {
  try {
    openDatabase("sweep", params.env);
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const now = Date.now();
        const rows = executeSqliteQuerySync(
          db,
          kysely(db)
            .selectFrom("plugin_blob_entries")
            .select(["entry_key", "metadata_json", "created_at", "expires_at"])
            .select((eb) => eb.fn<number | bigint>("length", ["blob"]).as("size_bytes"))
            .where("plugin_id", "=", params.pluginId)
            .where("namespace", "=", params.namespace)
            .where("expires_at", "is not", null)
            .where("expires_at", "<=", now)
            .orderBy("created_at", "asc")
            .orderBy("entry_key", "asc"),
        ).rows;
        // Return all cleanup metadata only after every row decodes and the claim commits.
        const entries = rows.map((row) => decodeBlobInfo<TMetadata>(row, "sweep", params.env));
        deleteExpiredNamespace(db, { ...params, now });
        return entries;
      },
      params.env ? { env: params.env } : {},
    );
  } catch (error) {
    throw wrapError(
      error,
      "sweep",
      "PLUGIN_BLOB_WRITE_FAILED",
      "Failed to delete expired plugin blobs.",
      params.env,
    );
  }
}

export function pluginBlobClear(params: {
  pluginId: string;
  namespace: string;
  env?: NodeJS.ProcessEnv;
}): void {
  try {
    openDatabase("clear", params.env);
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        executeSqliteQuerySync(
          db,
          kysely(db)
            .deleteFrom("plugin_blob_entries")
            .where("plugin_id", "=", params.pluginId)
            .where("namespace", "=", params.namespace),
        );
      },
      params.env ? { env: params.env } : {},
    );
  } catch (error) {
    throw wrapError(
      error,
      "clear",
      "PLUGIN_BLOB_WRITE_FAILED",
      "Failed to clear plugin blob entries.",
      params.env,
    );
  }
}
