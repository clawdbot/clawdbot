// SQLite persistence for plugin-owned byte blobs and JSON metadata.
import type { DatabaseSync } from "node:sqlite";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import type { Insertable, Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type {
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

export type PluginBlobStoredInfo = Pick<
  PluginBlobRow,
  "entry_key" | "metadata_json" | "created_at" | "expires_at"
> & { size_bytes: number | bigint };

export type PluginBlobStoredEntry = PluginBlobStoredInfo & { blob: Uint8Array };

type BlobDescriptor = {
  entry_key: string;
  namespace: string;
  created_at: number;
  size_bytes: number | bigint;
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

type ValidateMetadataJson = (metadataJson: string) => void;

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

function kysely(db: DatabaseSync) {
  return getNodeSqliteKysely<PluginBlobDatabase>(db);
}

function selectLiveBlob(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; key: string; now: number },
): PluginBlobStoredEntry | undefined {
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

function selectLiveDescriptors(
  db: DatabaseSync,
  params: { pluginId: string; now: number; namespace?: string; excludeKey?: string },
): BlobDescriptor[] {
  let query = kysely(db)
    .selectFrom("plugin_blob_entries")
    .select(["entry_key", "namespace", "created_at"])
    .select((eb) => eb.fn<number | bigint>("length", ["blob"]).as("size_bytes"))
    .where("plugin_id", "=", params.pluginId)
    .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", params.now)]));
  if (params.namespace !== undefined) {
    query = query.where("namespace", "=", params.namespace);
  }
  if (params.excludeKey !== undefined) {
    query = query.where("entry_key", "!=", params.excludeKey);
  }
  return executeSqliteQuerySync(db, query.orderBy("created_at", "asc").orderBy("entry_key", "asc"))
    .rows;
}

function selectStoredDescriptors(
  db: DatabaseSync,
  params: { pluginId: string; namespace?: string },
): BlobDescriptor[] {
  let query = kysely(db)
    .selectFrom("plugin_blob_entries")
    .select(["entry_key", "namespace", "created_at"])
    .select((eb) => eb.fn<number | bigint>("length", ["blob"]).as("size_bytes"))
    .where("plugin_id", "=", params.pluginId);
  if (params.namespace !== undefined) {
    query = query.where("namespace", "=", params.namespace);
  }
  return executeSqliteQuerySync(db, query.orderBy("created_at", "asc").orderBy("entry_key", "asc"))
    .rows;
}

function selectStoredKeyDescriptor(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; key: string },
): BlobDescriptor | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    kysely(db)
      .selectFrom("plugin_blob_entries")
      .select(["entry_key", "namespace", "created_at"])
      .select((eb) => eb.fn<number | bigint>("length", ["blob"]).as("size_bytes"))
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where("entry_key", "=", params.key),
  );
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

function totalBytes(rows: readonly { size_bytes: number | bigint }[]): number {
  return rows.reduce((total, row) => total + Number(row.size_bytes), 0);
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
  existing?: BlobDescriptor;
}): void {
  // Expired rows remain physically stored until their owner claims cleanup
  // metadata, so hard storage fuses must count them even though reads hide them.
  const namespaceRows = selectStoredDescriptors(params.db, {
    pluginId: params.write.pluginId,
    namespace: params.write.namespace,
  });
  const pluginRows = selectStoredDescriptors(params.db, {
    pluginId: params.write.pluginId,
  });
  const previousBytes = params.existing ? Number(params.existing.size_bytes) : 0;
  const rowDelta = params.existing ? 0 : 1;
  if (namespaceRows.length + rowDelta > params.write.maxEntries) {
    throw limitError("Plugin blob namespace reached its stored row limit.", params.write.env);
  }
  if (
    totalBytes(namespaceRows) - previousBytes + params.write.bytes.byteLength >
    params.write.maxBytesPerNamespace
  ) {
    throw limitError("Plugin blob namespace reached its stored byte limit.", params.write.env);
  }
  if (pluginRows.length + rowDelta > MAX_PLUGIN_BLOB_ENTRIES_PER_PLUGIN) {
    throw limitError("Plugin blob store reached its per-plugin row limit.", params.write.env);
  }
  if (
    totalBytes(pluginRows) - previousBytes + params.write.bytes.byteLength >
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
  const namespaceRows = selectStoredDescriptors(params.db, {
    pluginId: params.write.pluginId,
    namespace: params.write.namespace,
  });
  let namespaceCount = namespaceRows.length;
  let namespaceBytes = totalBytes(namespaceRows);
  const namespaceKeysToDelete: string[] = [];
  // Owner-managed expired rows are not eviction candidates: deleting one would
  // lose metadata for an external artifact that still needs cleanup.
  const namespaceCandidates = selectLiveDescriptors(params.db, {
    pluginId: params.write.pluginId,
    namespace: params.write.namespace,
    now: params.now,
    excludeKey: params.write.key,
  });
  for (const row of namespaceCandidates) {
    if (
      namespaceCount <= params.write.maxEntries &&
      namespaceBytes <= params.write.maxBytesPerNamespace
    ) {
      break;
    }
    namespaceKeysToDelete.push(row.entry_key);
    namespaceCount -= 1;
    namespaceBytes -= Number(row.size_bytes);
  }
  if (
    namespaceCount > params.write.maxEntries ||
    namespaceBytes > params.write.maxBytesPerNamespace
  ) {
    throw limitError(
      "Plugin blob namespace cannot satisfy its configured limits.",
      params.write.env,
    );
  }
  deleteKeys(params.db, {
    pluginId: params.write.pluginId,
    namespace: params.write.namespace,
    keys: namespaceKeysToDelete,
  });

  const pluginRows = selectStoredDescriptors(params.db, {
    pluginId: params.write.pluginId,
  });
  let pluginCount = pluginRows.length;
  let pluginBytes = totalBytes(pluginRows);
  // Global hard-cap accounting includes every namespace, but this namespace's
  // live rows are the only entries its overflow policy may safely evict.
  const liveNamespaceCandidates = selectLiveDescriptors(params.db, {
    pluginId: params.write.pluginId,
    namespace: params.write.namespace,
    now: params.now,
    excludeKey: params.write.key,
  });
  const pluginKeysToDelete: string[] = [];
  for (const row of liveNamespaceCandidates) {
    if (
      pluginCount <= MAX_PLUGIN_BLOB_ENTRIES_PER_PLUGIN &&
      pluginBytes <= MAX_PLUGIN_BLOB_BYTES_PER_PLUGIN
    ) {
      break;
    }
    pluginKeysToDelete.push(row.entry_key);
    pluginCount -= 1;
    pluginBytes -= Number(row.size_bytes);
  }
  if (
    pluginCount > MAX_PLUGIN_BLOB_ENTRIES_PER_PLUGIN ||
    pluginBytes > MAX_PLUGIN_BLOB_BYTES_PER_PLUGIN
  ) {
    throw limitError("Plugin blob store cannot satisfy its per-plugin limits.", params.write.env);
  }
  deleteKeys(params.db, {
    pluginId: params.write.pluginId,
    namespace: params.write.namespace,
    keys: pluginKeysToDelete,
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
        const existing = selectStoredKeyDescriptor(db, params);
        if (params.overflowPolicy === "reject-new") {
          assertProjectedLimits({ db, write: params, existing });
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

export function pluginBlobLookup(params: {
  pluginId: string;
  namespace: string;
  key: string;
  env?: NodeJS.ProcessEnv;
}): PluginBlobStoredEntry | undefined {
  try {
    const { db } = openDatabase("lookup", params.env);
    return selectLiveBlob(db, { ...params, now: Date.now() });
  } catch (error) {
    throw wrapError(
      error,
      "lookup",
      "PLUGIN_BLOB_READ_FAILED",
      "Failed to read plugin blob entry.",
      params.env,
    );
  }
}

export function pluginBlobEntries(params: {
  pluginId: string;
  namespace: string;
  env?: NodeJS.ProcessEnv;
}): PluginBlobStoredInfo[] {
  try {
    const { db } = openDatabase("entries", params.env);
    return selectLiveInfo(db, { ...params, now: Date.now() });
  } catch (error) {
    throw wrapError(
      error,
      "entries",
      "PLUGIN_BLOB_READ_FAILED",
      "Failed to list plugin blob entries.",
      params.env,
    );
  }
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

export function pluginBlobDeleteExpiredKey(params: {
  pluginId: string;
  namespace: string;
  key: string;
  env?: NodeJS.ProcessEnv;
  validateMetadataJson: ValidateMetadataJson;
}): PluginBlobStoredInfo | undefined {
  try {
    openDatabase("sweep", params.env);
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const row = selectExpiredKeyInfo(db, { ...params, now: Date.now() });
        if (!row) {
          return undefined;
        }
        params.validateMetadataJson(row.metadata_json);
        deleteKey(db, params);
        return row;
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

export function pluginBlobDeleteExpired(params: {
  pluginId: string;
  namespace: string;
  env?: NodeJS.ProcessEnv;
  validateMetadataJson: ValidateMetadataJson;
}): PluginBlobStoredInfo[] {
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
        for (const row of rows) {
          params.validateMetadataJson(row.metadata_json);
        }
        deleteExpiredNamespace(db, { ...params, now });
        return rows;
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
