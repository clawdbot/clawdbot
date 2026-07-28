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
import {
  createPersistentDedupeImportEntry,
  type PersistentDedupeEntry,
} from "openclaw/plugin-sdk/persistent-dedupe";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor";
import { isRecord } from "../../record-shared.js";
import { normalizeMatrixStorageMetadata } from "../client/storage.js";
import {
  buildMatrixInboundDedupeEventKey,
  MATRIX_INBOUND_DEDUPE_STATE_MAX_ENTRIES,
  MATRIX_INBOUND_DEDUPE_TTL_MS,
  resolveMatrixInboundDedupeStateNamespace,
} from "./inbound-dedupe.js";

const LEGACY_SQLITE_NAMESPACE = "inbound-dedupe";
const LEGACY_SQLITE_MAX_ENTRIES = 20_000;
const LEGACY_MARKERS_NAMESPACE = "inbound-dedupe-migrations";
const LEGACY_MARKERS_MAX_ENTRIES = 1_000;
const LEGACY_JSON_VERSION = 1;
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

export async function collectMatrixInboundDedupeSources(stateDir: string): Promise<{
  sqliteRoots: string[];
  jsonRoots: string[];
}> {
  const matrixRoot = path.join(stateDir, "matrix");
  const sqliteRoots = new Set<string>();
  const jsonRoots = new Set<string>();
  async function visit(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
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
  await visit(matrixRoot);
  const matrixRootResolved = path.resolve(matrixRoot);
  const isAccountRoot = (root: string) => path.resolve(root) !== matrixRootResolved;
  return {
    sqliteRoots: [...sqliteRoots].filter(isAccountRoot).toSorted(),
    jsonRoots: [...jsonRoots].filter(isAccountRoot).toSorted(),
  };
}

function openLegacySqliteStore(io: MatrixInboundDedupeMigrationIo, storageRootDir: string) {
  return io.context.openPluginStateKeyedStore<unknown>({
    namespace: LEGACY_SQLITE_NAMESPACE,
    maxEntries: LEGACY_SQLITE_MAX_ENTRIES,
    env: { ...io.env, OPENCLAW_STATE_DIR: storageRootDir },
  });
}

function openLegacyMarkersStore(io: MatrixInboundDedupeMigrationIo, storageRootDir: string) {
  return io.context.openPluginStateKeyedStore<unknown>({
    namespace: LEGACY_MARKERS_NAMESPACE,
    maxEntries: LEGACY_MARKERS_MAX_ENTRIES,
    env: { ...io.env, OPENCLAW_STATE_DIR: storageRootDir },
  });
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

/** Reads one storage root's legacy SQLite dedupe rows; throws on store errors. */
export async function readLegacyInboundDedupeSqliteSource(
  io: MatrixInboundDedupeMigrationIo,
  storageRootDir: string,
): Promise<{ markers: LegacyInboundDedupeMarker[]; legacyRowCount: number }> {
  const rows = await openLegacySqliteStore(io, storageRootDir).entries();
  const markerRows = await openLegacyMarkersStore(io, storageRootDir).entries();
  const markers: LegacyInboundDedupeMarker[] = [];
  for (const row of rows) {
    const marker = parseLegacySqliteRow(row);
    if (marker) {
      markers.push(marker);
    }
  }
  return { markers, legacyRowCount: rows.length + markerRows.length };
}

/** Clears one storage root's retired legacy dedupe namespaces after import. */
export async function retireLegacyInboundDedupeSqliteRows(
  io: MatrixInboundDedupeMigrationIo,
  storageRootDir: string,
): Promise<void> {
  await openLegacySqliteStore(io, storageRootDir).clear();
  await openLegacyMarkersStore(io, storageRootDir).clear();
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
 * Never exceeds capacity: eviction is by row creation time, so letting fresh
 * imports overflow the namespace would evict the newer rows the runtime
 * committed since the upgrade. Throws on store errors so the caller keeps the
 * legacy sources for the next doctor attempt.
 */
export async function importNewestInboundDedupeMarkers(params: {
  io: MatrixInboundDedupeMigrationIo;
  markers: Iterable<LegacyInboundDedupeMarker>;
  now?: number;
  stateMaxEntries?: number;
}): Promise<{ imported: number; total: number }> {
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
  let capacity = Math.max(0, stateMaxEntries - (await store.entries()).length);
  let imported = 0;
  for (const marker of markers) {
    if (capacity <= 0) {
      break;
    }
    const remainingTtlMs = MATRIX_INBOUND_DEDUPE_TTL_MS - (now - marker.ts);
    if (remainingTtlMs <= 0) {
      continue;
    }
    const entry = createPersistentDedupeImportEntry({
      key: marker.key,
      seenAt: marker.ts,
      ttlMs: Math.max(1, Math.floor(remainingTtlMs)),
    });
    // Rows committed after the upgrade are newer than any legacy marker, so
    // registerIfAbsent keeps them and only fills the missing keys.
    const registered = await store.registerIfAbsent(entry.key, entry.value, {
      ttlMs: entry.ttlMs ?? MATRIX_INBOUND_DEDUPE_TTL_MS,
    });
    if (registered) {
      imported += 1;
      capacity -= 1;
    }
  }
  return { imported, total: markers.length };
}
