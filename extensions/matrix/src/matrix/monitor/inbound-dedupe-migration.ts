// Legacy-source readers and importer for the one-time doctor migration of
// pre-claimable-dedupe inbound replay markers. Losing those markers would
// re-dispatch already-handled events on the first stale /sync or decrypt
// replay after upgrade. Two shipped sources exist:
// - >=2026.6 tags persisted rows in each account storage root's SQLite DB
//   (namespace `inbound-dedupe`, key `<accountId>:<sha256>`, value
//   `{roomId, eventId, ts}`), plus `inbound-dedupe-migrations` import markers.
// - <=2026.5 tags wrote `inbound-dedupe.json` beside the account sync store;
//   the retired runtime importer read it lazily, so upgrades that skip the
//   SQLite era can still carry the raw file.
// The PluginDoctorStateMigration itself lives in doctor-contract-api.ts, which
// also owns the legacy-file archival write.
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
// Doctor enumeration cold-loads this closure; persistent-dedupe pulls the
// plugin-state-store/kysely graph, so the value import stays lazy below.
import type { PersistentDedupeEntry } from "openclaw/plugin-sdk/persistent-dedupe";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeMatrixStorageMetadata } from "../client/storage-metadata.js";

const LEGACY_SQLITE_NAMESPACE = "inbound-dedupe";
const LEGACY_MARKERS_NAMESPACE = "inbound-dedupe-migrations";
const LEGACY_JSON_VERSION = 1;
const MATRIX_PLUGIN_ID = "matrix";
const MIGRATION_COMPLETION_NAMESPACE = "inbound-dedupe-migration-state";
const MIGRATION_COMPLETION_KEY = "sqlite-json-to-claimable-v1";
const STATE_DATABASE_RELATIVE_PATH = path.join("state", "openclaw.sqlite");
const STORAGE_META_FILENAME = "storage-meta.json";

export const MATRIX_LEGACY_INBOUND_DEDUPE_FILENAME = "inbound-dedupe.json";

export type MatrixInboundDedupeMigrationIo = {
  context: PluginDoctorStateMigrationContext;
  env: NodeJS.ProcessEnv;
};

export type LegacyInboundDedupeMarker = {
  accountId: string;
  roomId: string;
  eventId: string;
  ts: number;
};

type MatrixInboundDedupeSourceRoots = {
  sqliteRoots: string[];
  jsonRoots: string[];
};

type MatrixInboundDedupeSourceCensus =
  | ({ status: "complete" } & MatrixInboundDedupeSourceRoots)
  | ({ status: "incomplete"; warnings: string[] } & MatrixInboundDedupeSourceRoots);

type LegacySqliteRow = {
  namespace: string;
  entry_key: string;
  value_json: string;
  expires_at: number | bigint | null;
};

type MatrixInboundDedupeMigrationCompletion = {
  version: 1;
  completedAt: number;
};

function openMatrixInboundDedupeMigrationCompletionStore(
  context: PluginDoctorStateMigrationContext,
  env: NodeJS.ProcessEnv,
) {
  return context.openPluginStateKeyedStore<MatrixInboundDedupeMigrationCompletion>({
    namespace: MIGRATION_COMPLETION_NAMESPACE,
    maxEntries: 4,
    overflowPolicy: "reject-new",
    env,
  });
}

export async function hasCompletedMatrixInboundDedupeMigration(
  context: PluginDoctorStateMigrationContext,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const marker = await openMatrixInboundDedupeMigrationCompletionStore(context, env).lookup(
    MIGRATION_COMPLETION_KEY,
  );
  return (
    isRecord(marker) &&
    marker.version === 1 &&
    typeof marker.completedAt === "number" &&
    Number.isFinite(marker.completedAt) &&
    marker.completedAt >= 0
  );
}

export async function recordMatrixInboundDedupeMigrationCompletion(
  context: PluginDoctorStateMigrationContext,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await openMatrixInboundDedupeMigrationCompletionStore(context, env).register(
    MIGRATION_COMPLETION_KEY,
    { version: 1, completedAt: Date.now() },
  );
}

/**
 * Reserves the durable completion row before any legacy source is changed.
 * The invalid timestamp keeps detection active after an interrupted run, while
 * updating this same key after retirement remains possible at plugin capacity.
 */
export async function reserveMatrixInboundDedupeMigrationCompletion(
  context: PluginDoctorStateMigrationContext,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await openMatrixInboundDedupeMigrationCompletionStore(context, env).register(
    MIGRATION_COMPLETION_KEY,
    { version: 1, completedAt: -1 },
  );
}

export async function collectMatrixInboundDedupeSources(
  stateDir: string,
): Promise<MatrixInboundDedupeSourceCensus> {
  const matrixRoot = path.join(stateDir, "matrix");
  const sqliteRoots = new Set<string>();
  const jsonRoots = new Set<string>();
  const warnings: string[] = [];
  async function visit(dir: string, allowMissing = false): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (allowMissing && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      warnings.push(`Failed scanning Matrix inbound dedupe sources under ${dir}: ${String(err)}`);
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isFile()) {
        // Legacy per-root dedupe rows live in `<storageRoot>/state/openclaw.sqlite`.
        if (entry.name === "openclaw.sqlite" && path.basename(dir) === "state") {
          sqliteRoots.add(path.dirname(dir));
        } else if (entry.name === MATRIX_LEGACY_INBOUND_DEDUPE_FILENAME) {
          jsonRoots.add(dir);
        }
        continue;
      }
      if (entry.isDirectory()) {
        await visit(entryPath);
      }
    }
  }
  await visit(matrixRoot, true);
  const matrixRootResolved = path.resolve(matrixRoot);
  const isAccountRoot = (root: string) => path.resolve(root) !== matrixRootResolved;
  const roots = {
    sqliteRoots: [...sqliteRoots].filter(isAccountRoot).toSorted(),
    jsonRoots: [...jsonRoots].filter(isAccountRoot).toSorted(),
  };
  return warnings.length === 0
    ? { status: "complete", ...roots }
    : { status: "incomplete", ...roots, warnings };
}

function selectLegacySqliteRows(db: DatabaseSync): LegacySqliteRow[] {
  const table = db
    .prepare(
      `SELECT 1 AS present
       FROM sqlite_master
       WHERE type = 'table' AND name = 'plugin_state_entries'`,
    )
    .get();
  if (!table) {
    return [];
  }
  return db
    .prepare(
      `SELECT namespace, entry_key, value_json, expires_at
       FROM plugin_state_entries
       WHERE plugin_id = ? AND namespace IN (?, ?)
       ORDER BY namespace ASC, created_at ASC, entry_key ASC`,
    )
    .all(MATRIX_PLUGIN_ID, LEGACY_SQLITE_NAMESPACE, LEGACY_MARKERS_NAMESPACE) as LegacySqliteRow[];
}

function isLegacySqliteRowExpired(row: LegacySqliteRow, now: number): boolean {
  if (typeof row.expires_at === "bigint") {
    return row.expires_at <= BigInt(now);
  }
  return row.expires_at !== null && row.expires_at <= now;
}

function normalizeLegacyTimestamp(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return null;
  }
  return Math.max(0, Math.floor(raw));
}

function parseLegacySqliteRow(row: {
  key: string;
  value: unknown;
}): LegacyInboundDedupeMarker | null {
  const value = isRecord(row.value) ? row.value : {};
  const roomId = typeof value.roomId === "string" ? value.roomId.trim() : "";
  const eventId = typeof value.eventId === "string" ? value.eventId.trim() : "";
  const ts = normalizeLegacyTimestamp(value.ts);
  const separator = row.key.lastIndexOf(":");
  if (!roomId || !eventId || ts === null || separator <= 0) {
    return null;
  }
  const accountId = row.key.slice(0, separator);
  // Legacy keys embed sha256(accountId\0roomId\0eventId); recomputing it
  // validates the account-prefix parse and drops corrupt rows, mirroring the
  // retired runtime loader's expected-key check.
  const digest = createHash("sha256")
    .update(accountId)
    .update("\0")
    .update(roomId)
    .update("\0")
    .update(eventId)
    .digest("hex");
  if (row.key.slice(separator + 1) !== digest) {
    return null;
  }
  return { accountId, roomId, eventId, ts };
}

/**
 * Reads one storage root's legacy SQLite dedupe rows without opening it through
 * the current state runtime. Historical per-account databases can predate the
 * current core schema, and detection must not upgrade them merely to inspect
 * these retired plugin-state namespaces.
 */
export async function readLegacyInboundDedupeSqliteSource(
  storageRootDir: string,
): Promise<{ markers: LegacyInboundDedupeMarker[]; legacyRowCount: number }> {
  // sqlite-runtime re-exports the agent-db/kysely graph; keep it lazy so doctor
  // enumeration does not cold-load it with this closure.
  const { openNodeSqliteDatabase } = await import("openclaw/plugin-sdk/sqlite-runtime");
  const databasePath = path.join(storageRootDir, STATE_DATABASE_RELATIVE_PATH);
  const db = openNodeSqliteDatabase(databasePath, { readOnly: true });
  try {
    const rows = selectLegacySqliteRows(db);
    const markers: LegacyInboundDedupeMarker[] = [];
    const now = Date.now();
    for (const row of rows) {
      // The keyed-store reader filtered expired rows before decoding them. We
      // still count that residue so doctor can retire it, but it has no replay
      // value and malformed expired JSON must not block the whole root.
      if (isLegacySqliteRowExpired(row, now)) {
        continue;
      }
      // The keyed-store reader parsed every value, including import-marker
      // values. Keep that fail-closed behavior so corrupt sources are not
      // retired unread.
      const value = JSON.parse(row.value_json) as unknown;
      if (row.namespace !== LEGACY_SQLITE_NAMESPACE) {
        continue;
      }
      const marker = parseLegacySqliteRow({ key: row.entry_key, value });
      if (marker) {
        markers.push(marker);
      }
    }
    return { markers, legacyRowCount: rows.length };
  } finally {
    db.close();
  }
}

/** Deletes only the two retired Matrix namespaces after a successful import. */
export async function retireLegacyInboundDedupeSqliteRows(storageRootDir: string): Promise<void> {
  const { openNodeSqliteDatabase, runSqliteImmediateTransactionSync } =
    await import("openclaw/plugin-sdk/sqlite-runtime");
  const databasePath = path.join(storageRootDir, STATE_DATABASE_RELATIVE_PATH);
  const db = openNodeSqliteDatabase(databasePath);
  try {
    // Plan outside the write transaction, then re-read after BEGIN IMMEDIATE
    // before deleting. The predicates intentionally cannot touch other Matrix
    // namespaces or another plugin's rows.
    if (selectLegacySqliteRows(db).length === 0) {
      return;
    }
    runSqliteImmediateTransactionSync(db, () => {
      if (selectLegacySqliteRows(db).length === 0) {
        return;
      }
      db.prepare(
        `DELETE FROM plugin_state_entries
         WHERE plugin_id = ? AND namespace IN (?, ?)`,
      ).run(MATRIX_PLUGIN_ID, LEGACY_SQLITE_NAMESPACE, LEGACY_MARKERS_NAMESPACE);
    });
  } finally {
    db.close();
  }
}

export async function verifyMatrixInboundDedupeSourcesRetired(stateDir: string): Promise<string[]> {
  const warnings: string[] = [];
  const remaining = await collectMatrixInboundDedupeSources(stateDir);
  if (remaining.status === "incomplete") {
    warnings.push(...remaining.warnings);
  }
  for (const storageRootDir of remaining.sqliteRoots) {
    try {
      if ((await readLegacyInboundDedupeSqliteSource(storageRootDir)).legacyRowCount > 0) {
        warnings.push(`Matrix inbound dedupe rows remain after retirement for ${storageRootDir}`);
      }
    } catch (err) {
      warnings.push(
        `Failed verifying retired Matrix inbound dedupe rows for ${storageRootDir}: ${String(err)}`,
      );
    }
  }
  for (const storageRootDir of remaining.jsonRoots) {
    warnings.push(`Matrix inbound dedupe JSON remains after retirement for ${storageRootDir}`);
  }
  return warnings;
}

async function resolveJsonRootAccountId(storageRootDir: string): Promise<string> {
  // The JSON era predates the per-root SQLite stores, so account identity comes
  // from storage-meta.json (or its doctor-archived copy when the metadata
  // migration already ran). Pre-metadata roots belong to the legacy single
  // account, which used the literal "default" account id.
  for (const filename of [STORAGE_META_FILENAME, `${STORAGE_META_FILENAME}.migrated`]) {
    try {
      const metadata = normalizeMatrixStorageMetadata(
        JSON.parse(await fs.readFile(path.join(storageRootDir, filename), "utf8")) as unknown,
      );
      if (metadata?.accountId) {
        return metadata.accountId;
      }
    } catch {
      // Try the next metadata source.
    }
  }
  return "default";
}

/**
 * Reads one storage root's legacy inbound-dedupe.json markers. Throws on file
 * read errors so a transiently unreadable file is never retired unread, and
 * returns null for malformed content so the caller can archive it explicitly.
 */
export async function readLegacyInboundDedupeJsonSource(
  storageRootDir: string,
): Promise<LegacyInboundDedupeMarker[] | null> {
  const jsonPath = path.join(storageRootDir, MATRIX_LEGACY_INBOUND_DEDUPE_FILENAME);
  const raw = await fs.readFile(jsonPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== LEGACY_JSON_VERSION ||
    !Array.isArray(parsed.entries)
  ) {
    return null;
  }
  const accountId = await resolveJsonRootAccountId(storageRootDir);
  const markers: LegacyInboundDedupeMarker[] = [];
  for (const entry of parsed.entries) {
    if (!isRecord(entry) || typeof entry.key !== "string") {
      continue;
    }
    // Legacy JSON keys are `roomId|eventId`; event ids never contain "|".
    const separator = entry.key.indexOf("|");
    if (separator <= 0) {
      continue;
    }
    const roomId = entry.key.slice(0, separator).trim();
    const eventId = entry.key.slice(separator + 1).trim();
    const ts = normalizeLegacyTimestamp(entry.ts);
    if (!roomId || !eventId || ts === null) {
      continue;
    }
    markers.push({ accountId, roomId, eventId, ts });
  }
  return markers;
}

/**
 * Imports the globally newest legacy markers into the claimable-dedupe store.
 * Never exceeds capacity, never replaces a post-upgrade destination row, and
 * preserves source timestamps because eviction is ordered by row creation
 * time. Throws on import or verification errors so the caller keeps the legacy
 * sources for the next doctor attempt.
 */
export async function importNewestInboundDedupeMarkers(params: {
  io: MatrixInboundDedupeMigrationIo;
  markers: Iterable<LegacyInboundDedupeMarker>;
  now?: number;
  stateMaxEntries?: number;
}): Promise<{ imported: number; total: number }> {
  const { createPersistentDedupeImportEntry } =
    await import("openclaw/plugin-sdk/persistent-dedupe");
  // inbound-dedupe.js value-imports persistent-dedupe's replay guard, so the
  // runtime module also stays out of this closure's static import graph.
  const {
    buildMatrixInboundDedupeEventKey,
    MATRIX_INBOUND_DEDUPE_STATE_MAX_ENTRIES,
    MATRIX_INBOUND_DEDUPE_TTL_MS,
    resolveMatrixInboundDedupeStateNamespace,
  } = await import("./inbound-dedupe.js");
  const now = params.now ?? Date.now();
  const stateMaxEntries = params.stateMaxEntries ?? MATRIX_INBOUND_DEDUPE_STATE_MAX_ENTRIES;
  const newestByKey = new Map<string, LegacyInboundDedupeMarker & { key: string }>();
  for (const marker of params.markers) {
    const key = buildMatrixInboundDedupeEventKey(marker);
    if (!key) {
      continue;
    }
    const existing = newestByKey.get(key);
    if (!existing || marker.ts > existing.ts) {
      newestByKey.set(key, { ...marker, key });
    }
  }
  // Newest first so the capacity limit drops the least replay-relevant markers.
  const markers = [...newestByKey.values()].toSorted((left, right) => right.ts - left.ts);
  const store = params.io.context.openPluginStateKeyedStore<PersistentDedupeEntry>({
    namespace: resolveMatrixInboundDedupeStateNamespace(),
    maxEntries: stateMaxEntries,
    defaultTtlMs: MATRIX_INBOUND_DEDUPE_TTL_MS,
    env: params.io.env,
  });
  const existingEntries = await store.entries();
  const existingKeys = new Set(existingEntries.map((entry) => entry.key));
  const missingEntries = markers.flatMap((marker) => {
    const remainingTtlMs = MATRIX_INBOUND_DEDUPE_TTL_MS - (now - marker.ts);
    if (remainingTtlMs <= 0) {
      return [];
    }
    const entry = createPersistentDedupeImportEntry({
      key: marker.key,
      seenAt: marker.ts,
      ttlMs: Math.max(1, Math.floor(remainingTtlMs)),
    });
    return existingKeys.has(entry.key) ? [] : [{ marker, entry }];
  });
  const namespaceCapacity = Math.max(0, stateMaxEntries - existingEntries.length);
  const pluginCapacity =
    missingEntries.length > 0 ? params.io.context.getPluginStateCapacity?.() : undefined;
  if (missingEntries.length > 0 && !pluginCapacity) {
    throw new Error("plugin-wide Matrix inbound dedupe import capacity is unavailable");
  }
  const pluginRemainingCapacity = pluginCapacity
    ? Math.max(0, pluginCapacity.maxEntries - pluginCapacity.liveEntries)
    : namespaceCapacity;
  const capacity = Math.min(namespaceCapacity, pluginRemainingCapacity);
  const selectedEntries = missingEntries.slice(0, capacity);
  if (selectedEntries.length > 0) {
    const importEntries = params.io.context.importPluginStateEntries;
    if (!importEntries) {
      throw new Error("retention-aware Matrix inbound dedupe import is unavailable");
    }
    importEntries(
      {
        namespace: resolveMatrixInboundDedupeStateNamespace(),
        maxEntries: stateMaxEntries,
        defaultTtlMs: MATRIX_INBOUND_DEDUPE_TTL_MS,
        env: params.io.env,
      },
      selectedEntries.map(({ marker, entry }) => ({
        key: entry.key,
        value: entry.value,
        createdAt: marker.ts,
        ...(entry.ttlMs != null ? { ttlMs: entry.ttlMs } : {}),
      })),
    );
    const importedKeys = new Set((await store.entries()).map((entry) => entry.key));
    const missingKey = selectedEntries.find(({ entry }) => !importedKeys.has(entry.key))?.entry.key;
    if (missingKey) {
      throw new Error(`retention-aware Matrix inbound dedupe import did not persist ${missingKey}`);
    }
  }
  return { imported: selectedEntries.length, total: markers.length };
}
