// Doctor-only import for retired managed outgoing image metadata JSON files.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString as optionalNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import {
  managedImageRecordFromRow,
  managedImageRecordsEqual,
  managedImageRecordToRow,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
  type ManagedImageRecord,
  type ManagedImageRecordDatabase,
} from "../gateway/managed-image-record-store.js";
import { getMediaDir } from "../media/store.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { assertAllowedJsonFields } from "./state-migrations.json-fields.js";
import {
  legacyMigrationSourceSnapshotsMatch as sourceSnapshotsMatch,
  readLegacyMigrationSourceSnapshotSync,
  type LegacyMigrationSourceSnapshot as LegacySourceSnapshot,
} from "./state-migrations.source-snapshot.js";
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";

const LEGACY_RECORD_MAX_BYTES = 1024 * 1024;
const DEFAULT_TRANSIENT_TTL_MS = 15 * 60 * 1000;
const ATTACHMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOCTOR_CLAIM_MARKER = ".json.doctor-importing-";
const DOCTOR_CLAIM_SUFFIX_RE =
  /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECORD_KEYS = new Set([
  "attachmentId",
  "sessionKey",
  "agentId",
  "messageId",
  "createdAt",
  "updatedAt",
  "retentionClass",
  "alt",
  "original",
]);
const ORIGINAL_KEYS = new Set(["path", "contentType", "width", "height", "sizeBytes", "filename"]);

type ParsedLegacyRecord = {
  record: ManagedImageRecord;
  snapshot: LegacySourceSnapshot;
  originalPath: string;
};

type ClaimedLegacySource = {
  claimPath: string;
  sourcePath: string;
  parsed: ParsedLegacyRecord;
};

function resolveLegacyManagedOutgoingImageRecordsDir(stateDir: string): string {
  return path.join(stateDir, "media", "outgoing", "records");
}

function sourceNameFromDoctorClaim(name: string): string | null {
  const markerIndex = name.indexOf(DOCTOR_CLAIM_MARKER);
  if (markerIndex < 0) {
    return null;
  }
  const attachmentId = name.slice(0, markerIndex);
  const suffix = name.slice(markerIndex + DOCTOR_CLAIM_MARKER.length);
  return ATTACHMENT_ID_RE.test(attachmentId) && DOCTOR_CLAIM_SUFFIX_RE.test(suffix)
    ? `${attachmentId}.json`
    : null;
}

function isLegacyManagedImageSourceName(name: string): boolean {
  return name.endsWith(".json") || sourceNameFromDoctorClaim(name) !== null;
}

export function detectLegacyManagedOutgoingImages(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyStateDetection["managedOutgoingImages"] {
  const sourceDir = resolveLegacyManagedOutgoingImageRecordsDir(params.stateDir);
  let hasLegacy = false;
  if (params.doctorOnlyStateMigrations === true) {
    try {
      hasLegacy = fs.readdirSync(sourceDir).some(isLegacyManagedImageSourceName);
    } catch {
      hasLegacy = false;
    }
  }
  return { sourceDir, hasLegacy };
}

function recoverInterruptedDoctorClaims(sourceDir: string): void {
  for (const claimName of fs.readdirSync(sourceDir).toSorted()) {
    const sourceName = sourceNameFromDoctorClaim(claimName);
    if (!sourceName) {
      continue;
    }
    const claimPath = path.join(sourceDir, claimName);
    const sourcePath = path.join(sourceDir, sourceName);
    const claimSnapshot = readLegacySourceSnapshot(claimPath);
    if (!fs.existsSync(sourcePath)) {
      fs.renameSync(claimPath, sourcePath);
      continue;
    }
    const sourceSnapshot = readLegacySourceSnapshot(sourcePath);
    if (
      sourceSnapshot.size !== claimSnapshot.size ||
      sourceSnapshot.sha256 !== claimSnapshot.sha256
    ) {
      throw new Error(`interrupted managed image claim conflicts with ${sourcePath}`);
    }
    fs.unlinkSync(claimPath);
  }
}

function readLegacySourceSnapshot(sourcePath: string): LegacySourceSnapshot {
  return readLegacyMigrationSourceSnapshotSync({
    sourcePath,
    label: "managed image",
    maxBytes: LEGACY_RECORD_MAX_BYTES,
  });
}

function nullableNonNegativeInteger(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return asSafeIntegerInRange(value, { min: 0 });
}

function parseLegacyManagedImageRecord(params: {
  snapshot: LegacySourceSnapshot;
  stateDir: string;
}): ParsedLegacyRecord {
  const raw = JSON.parse(params.snapshot.raw) as unknown;
  if (!isRecord(raw) || !isRecord(raw.original)) {
    throw new Error("legacy managed image record must be an object");
  }
  assertAllowedJsonFields(raw, RECORD_KEYS, "legacy managed image record");
  assertAllowedJsonFields(raw.original, ORIGINAL_KEYS, "legacy managed image record", {
    fieldPrefix: "original.",
  });

  const attachmentId = optionalNonEmptyString(raw.attachmentId);
  const sessionKey = optionalNonEmptyString(raw.sessionKey);
  const agentId = optionalNonEmptyString(raw.agentId);
  const messageId = raw.messageId === null ? null : optionalNonEmptyString(raw.messageId);
  const createdAt = optionalNonEmptyString(raw.createdAt);
  const updatedAt = optionalNonEmptyString(raw.updatedAt);
  const alt = typeof raw.alt === "string" ? raw.alt : undefined;
  const retentionClass = raw.retentionClass;
  const originalPath = optionalNonEmptyString(raw.original.path);
  const contentType = optionalNonEmptyString(raw.original.contentType);
  const width = nullableNonNegativeInteger(raw.original.width);
  const height = nullableNonNegativeInteger(raw.original.height);
  const sizeBytes = nullableNonNegativeInteger(raw.original.sizeBytes);
  const filename =
    raw.original.filename === null ? null : optionalNonEmptyString(raw.original.filename);
  if (
    !attachmentId ||
    !ATTACHMENT_ID_RE.test(attachmentId) ||
    path.basename(params.snapshot.sourcePath) !== `${attachmentId}.json` ||
    !sessionKey ||
    (raw.agentId !== undefined && !agentId) ||
    (raw.messageId !== null && messageId === undefined) ||
    !createdAt ||
    !Number.isFinite(Date.parse(createdAt)) ||
    (raw.updatedAt !== undefined && (!updatedAt || !Number.isFinite(Date.parse(updatedAt)))) ||
    (retentionClass !== undefined &&
      retentionClass !== "transient" &&
      retentionClass !== "history") ||
    alt === undefined ||
    !originalPath ||
    !contentType ||
    width === undefined ||
    height === undefined ||
    sizeBytes === undefined ||
    (raw.original.filename !== null && filename === undefined)
  ) {
    throw new Error(`legacy managed image record is invalid: ${params.snapshot.sourcePath}`);
  }

  const resolvedOriginalPath = path.resolve(originalPath);
  const mediaRoot = path.dirname(path.dirname(path.dirname(resolvedOriginalPath)));
  const allowedMediaRoots = new Set([
    path.resolve(params.stateDir, "media"),
    path.resolve(getMediaDir()),
  ]);
  if (
    !allowedMediaRoots.has(mediaRoot) ||
    path.dirname(resolvedOriginalPath) !== path.join(mediaRoot, MANAGED_OUTGOING_ORIGINALS_SUBDIR)
  ) {
    throw new Error("legacy managed image original is outside managed outgoing storage");
  }
  const mediaId = path.basename(resolvedOriginalPath);
  if (!mediaId || mediaId === "." || mediaId === "..") {
    throw new Error("legacy managed image original has an invalid media id");
  }

  return {
    snapshot: params.snapshot,
    originalPath: resolvedOriginalPath,
    record: {
      attachmentId,
      sessionKey,
      ...(agentId ? { agentId } : {}),
      messageId: messageId ?? null,
      createdAt,
      ...(updatedAt ? { updatedAt } : {}),
      ...(retentionClass === "transient" || retentionClass === "history" ? { retentionClass } : {}),
      alt,
      original: {
        mediaRoot,
        mediaId,
        mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
        contentType,
        width,
        height,
        sizeBytes,
        filename: filename ?? null,
      },
    },
  };
}

function restoreClaimedSources(claimed: readonly ClaimedLegacySource[]): string[] {
  const restoreErrors: string[] = [];
  for (const entry of claimed.toReversed()) {
    if (!fs.existsSync(entry.claimPath)) {
      continue;
    }
    if (fs.existsSync(entry.sourcePath)) {
      restoreErrors.push(`source path already exists: ${entry.sourcePath}`);
      continue;
    }
    try {
      fs.renameSync(entry.claimPath, entry.sourcePath);
    } catch (error) {
      restoreErrors.push(String(error));
    }
  }
  return restoreErrors;
}

function appendRestoreFailures(error: unknown, restoreErrors: readonly string[]): string {
  return `${String(error)}${restoreErrors.length > 0 ? `; restore failures: ${restoreErrors.join("; ")}` : ""}`;
}

function claimLegacySources(params: {
  records: readonly ParsedLegacyRecord[];
  beforeClaim?: () => void;
}): ClaimedLegacySource[] {
  params.beforeClaim?.();
  const claimed: ClaimedLegacySource[] = [];
  try {
    for (const parsed of params.records) {
      const sourcePath = parsed.snapshot.sourcePath;
      const claimPath = `${sourcePath}.doctor-importing-${process.pid}-${randomUUID()}`;
      fs.renameSync(sourcePath, claimPath);
      claimed.push({ claimPath, sourcePath, parsed });
      const claimedSnapshot = readLegacySourceSnapshot(claimPath);
      if (!sourceSnapshotsMatch(claimedSnapshot, parsed.snapshot)) {
        throw new Error(
          `legacy managed image source changed before doctor claimed it: ${sourcePath}`,
        );
      }
    }
    return claimed;
  } catch (error) {
    throw new Error(appendRestoreFailures(error, restoreClaimedSources(claimed)), { cause: error });
  }
}

function verifyClaimedSources(claimed: readonly ClaimedLegacySource[]): void {
  for (const entry of claimed) {
    const claimedSnapshot = readLegacySourceSnapshot(entry.claimPath);
    if (!sourceSnapshotsMatch(claimedSnapshot, entry.parsed.snapshot)) {
      throw new Error(`claimed legacy managed image source changed: ${entry.sourcePath}`);
    }
    if (fs.existsSync(entry.sourcePath)) {
      throw new Error(`legacy managed image source was replaced while doctor imported it`);
    }
  }
}

function removeClaimedSources(params: {
  claimed: readonly ClaimedLegacySource[];
  removeSource?: (sourcePath: string) => void;
}): void {
  try {
    for (const entry of params.claimed) {
      (params.removeSource ?? fs.unlinkSync)(entry.claimPath);
    }
  } catch (error) {
    throw new Error(appendRestoreFailures(error, restoreClaimedSources(params.claimed)), {
      cause: error,
    });
  }
}

function isExpiredTransient(record: ManagedImageRecord, nowMs: number, transientTtlMs: number) {
  const createdAtMs = Date.parse(record.createdAt);
  return (
    record.messageId === null &&
    Number.isFinite(createdAtMs) &&
    nowMs - createdAtMs >= transientTtlMs
  );
}

function rollbackImportedRecords(params: {
  records: readonly ParsedLegacyRecord[];
  stateDir: string;
}): string | null {
  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const stateDb = getNodeSqliteKysely<ManagedImageRecordDatabase>(db);
        for (const parsed of params.records) {
          const row = executeSqliteQueryTakeFirstSync(
            db,
            stateDb
              .selectFrom("managed_outgoing_image_records")
              .selectAll()
              .where("attachment_id", "=", parsed.record.attachmentId),
          );
          if (
            !row ||
            row.cleanup_pending === 1 ||
            !managedImageRecordsEqual(managedImageRecordFromRow(row), parsed.record)
          ) {
            continue;
          }
          executeSqliteQuerySync(
            db,
            stateDb
              .deleteFrom("managed_outgoing_image_records")
              .where("attachment_id", "=", parsed.record.attachmentId),
          );
        }
      },
      { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } },
    );
    return null;
  } catch (error) {
    return String(error);
  }
}

/** Import, verify, and remove retired record JSON during explicit Doctor repair. */
export function migrateLegacyManagedOutgoingImages(params: {
  detected: LegacyStateDetection["managedOutgoingImages"];
  stateDir: string;
  nowMs?: number;
  transientTtlMs?: number;
  beforeClaim?: () => void;
  beforeVerify?: () => void;
  removeSource?: (sourcePath: string) => void;
}): MigrationMessages {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!params.detected.hasLegacy) {
    return { changes, warnings };
  }

  let parsedRecords: ParsedLegacyRecord[];
  try {
    const sourceDirStat = fs.lstatSync(params.detected.sourceDir);
    if (!sourceDirStat.isDirectory() || sourceDirStat.isSymbolicLink()) {
      throw new Error("legacy managed image records owner is not a regular directory");
    }
    recoverInterruptedDoctorClaims(params.detected.sourceDir);
    parsedRecords = fs
      .readdirSync(params.detected.sourceDir)
      .filter((name) => name.endsWith(".json"))
      .toSorted()
      .map((name) =>
        parseLegacyManagedImageRecord({
          snapshot: readLegacySourceSnapshot(path.join(params.detected.sourceDir, name)),
          stateDir: params.stateDir,
        }),
      );
  } catch (error) {
    warnings.push(`Failed reading legacy managed outgoing image state: ${String(error)}`);
    return { changes, warnings };
  }

  const nowMs = params.nowMs ?? Date.now();
  const transientTtlMs = params.transientTtlMs ?? DEFAULT_TRANSIENT_TTL_MS;
  const discardedIds = new Set<string>();
  const insertedRecords: ParsedLegacyRecord[] = [];
  let claimed: ClaimedLegacySource[];
  try {
    claimed = claimLegacySources({ records: parsedRecords, beforeClaim: params.beforeClaim });
  } catch (error) {
    warnings.push(`Failed claiming legacy managed outgoing image state: ${String(error)}`);
    return { changes, warnings };
  }

  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const stateDb = getNodeSqliteKysely<ManagedImageRecordDatabase>(db);
        for (const parsed of parsedRecords) {
          const existing = executeSqliteQueryTakeFirstSync(
            db,
            stateDb
              .selectFrom("managed_outgoing_image_records")
              .selectAll()
              .where("attachment_id", "=", parsed.record.attachmentId),
          );
          if (existing) {
            if (!managedImageRecordsEqual(managedImageRecordFromRow(existing), parsed.record)) {
              throw new Error(
                `legacy managed image record conflicts with shared SQLite state: ${parsed.record.attachmentId}`,
              );
            }
            continue;
          }
          if (isExpiredTransient(parsed.record, nowMs, transientTtlMs)) {
            discardedIds.add(parsed.record.attachmentId);
            continue;
          }
          executeSqliteQuerySync(
            db,
            stateDb
              .insertInto("managed_outgoing_image_records")
              .values(managedImageRecordToRow(parsed.record)),
          );
          insertedRecords.push(parsed);
        }
      },
      { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } },
    );
  } catch (error) {
    warnings.push(
      `Failed migrating legacy managed outgoing image state: ${appendRestoreFailures(error, restoreClaimedSources(claimed))}`,
    );
    return { changes, warnings };
  }

  try {
    params.beforeVerify?.();
    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir },
    });
    const stateDb = getNodeSqliteKysely<ManagedImageRecordDatabase>(database.db);
    for (const parsed of parsedRecords) {
      const row = executeSqliteQueryTakeFirstSync(
        database.db,
        stateDb
          .selectFrom("managed_outgoing_image_records")
          .selectAll()
          .where("attachment_id", "=", parsed.record.attachmentId),
      );
      if (discardedIds.has(parsed.record.attachmentId)) {
        if (row) {
          throw new Error(
            `discarded transient record unexpectedly exists: ${parsed.record.attachmentId}`,
          );
        }
      } else if (!row || !managedImageRecordsEqual(managedImageRecordFromRow(row), parsed.record)) {
        throw new Error(`managed image verification failed: ${parsed.record.attachmentId}`);
      }
    }
    verifyClaimedSources(claimed);
  } catch (error) {
    const rollbackError = rollbackImportedRecords({
      records: insertedRecords,
      stateDir: params.stateDir,
    });
    const restoreErrors = restoreClaimedSources(claimed);
    warnings.push(
      `Failed verifying legacy managed outgoing image migration: ${appendRestoreFailures(error, restoreErrors)}` +
        (rollbackError ? `; SQLite rollback failure: ${rollbackError}` : ""),
    );
    return { changes, warnings };
  }

  let deletedExpiredFiles = 0;
  try {
    for (const parsed of parsedRecords) {
      if (!discardedIds.has(parsed.record.attachmentId)) {
        continue;
      }
      fs.rmSync(parsed.originalPath, { force: true });
      deletedExpiredFiles += 1;
    }
  } catch (error) {
    warnings.push(
      `Failed deleting expired legacy managed image attachments: ${appendRestoreFailures(error, restoreClaimedSources(claimed))}`,
    );
    return { changes, warnings };
  }

  try {
    removeClaimedSources({
      claimed,
      removeSource: params.removeSource,
    });
  } catch (error) {
    warnings.push(
      `Migrated managed outgoing images but could not remove legacy JSON: ${String(error)}`,
    );
    return { changes, warnings };
  }
  try {
    fs.rmdirSync(params.detected.sourceDir);
  } catch {
    // Preserve unrelated files and concurrent additions.
  }

  const importedCount = parsedRecords.length - discardedIds.size;
  if (importedCount > 0) {
    changes.push(
      `Migrated ${importedCount} managed outgoing image record(s) → shared SQLite state`,
    );
  }
  if (discardedIds.size > 0) {
    changes.push(
      `Discarded ${discardedIds.size} expired managed outgoing image record(s)` +
        (deletedExpiredFiles > 0 ? ` and ${deletedExpiredFiles} attachment file(s)` : ""),
    );
  }
  changes.push("Removed legacy managed outgoing image JSON after SQLite verification");
  return { changes, warnings };
}
