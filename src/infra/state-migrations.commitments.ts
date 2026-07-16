// Doctor-only import for the retired commitments JSON store.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  coerceCommitmentRecord,
  commitmentImmutableIdentity,
  commitmentRecordFromRow,
  commitmentRecordsEqual,
  commitmentRecordToRow,
  commitmentRecordToUpdate,
  type CommitmentRow,
  type CommitmentsDatabase,
} from "../commitments/store-record.js";
import type { CommitmentRecord } from "../commitments/types.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";

type LegacySourceSnapshot = {
  dev: number;
  ino: number;
  mtimeMs: number;
  raw: string;
  sha256: string;
  size: number;
};

const LEGACY_STORE_KEYS = new Set(["version", "commitments"]);
const ACTIVE_STATUSES = ["pending", "snoozed"] as const;

function resolveLegacyCommitmentsPath(stateDir: string): string {
  return path.join(stateDir, "commitments", "commitments.json");
}

/** Detect retired commitment state only when an explicit doctor flow opts in. */
export function detectLegacyCommitments(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyStateDetection["commitments"] {
  const sourcePath = resolveLegacyCommitmentsPath(params.stateDir);
  return {
    sourcePath,
    hasLegacy: params.doctorOnlyStateMigrations === true && fs.existsSync(sourcePath),
  };
}

function readLegacySourceSnapshot(sourcePath: string): LegacySourceSnapshot {
  const before = fs.lstatSync(sourcePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("legacy commitments source is not a regular non-symlink file");
  }
  const raw = fs.readFileSync(sourcePath, "utf8");
  const after = fs.lstatSync(sourcePath);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error("legacy commitments source changed while doctor was reading it");
  }
  return {
    dev: after.dev,
    ino: after.ino,
    mtimeMs: after.mtimeMs,
    raw,
    sha256: createHash("sha256").update(raw).digest("hex"),
    size: after.size,
  };
}

function sourceSnapshotsMatch(left: LegacySourceSnapshot, right: LegacySourceSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256 &&
    left.size === right.size
  );
}

function assertLegacySourceUnchanged(sourcePath: string, snapshot: LegacySourceSnapshot): void {
  if (!sourceSnapshotsMatch(readLegacySourceSnapshot(sourcePath), snapshot)) {
    throw new Error("legacy commitments source changed after doctor loaded it");
  }
}

function parseLegacyCommitments(raw: string): CommitmentRecord[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.commitments)) {
    throw new Error("legacy commitments store must be a version 1 JSON object");
  }
  const unexpectedKey = Object.keys(parsed).find((key) => !LEGACY_STORE_KEYS.has(key));
  if (unexpectedKey) {
    throw new Error(`legacy commitments store has unexpected field ${unexpectedKey}`);
  }
  const records: CommitmentRecord[] = [];
  const ids = new Set<string>();
  for (const [index, rawRecord] of parsed.commitments.entries()) {
    const record = coerceCommitmentRecord(rawRecord);
    if (!record) {
      throw new Error(`legacy commitment at index ${index} is invalid`);
    }
    if (ids.has(record.id)) {
      throw new Error(`legacy commitments store contains duplicate id ${record.id}`);
    }
    ids.add(record.id);
    records.push(record);
  }
  return records;
}

function sameLogicalScope(left: CommitmentRecord, right: CommitmentRecord): boolean {
  return (
    left.agentId === right.agentId &&
    left.sessionKey === right.sessionKey &&
    left.channel === right.channel &&
    (left.accountId ?? "") === (right.accountId ?? "") &&
    (left.to ?? "") === (right.to ?? "") &&
    (left.threadId ?? "") === (right.threadId ?? "") &&
    (left.senderId ?? "") === (right.senderId ?? "") &&
    left.dedupeKey === right.dedupeKey
  );
}

function findActiveLogicalRow(
  db: DatabaseSync,
  record: CommitmentRecord,
): CommitmentRow | undefined {
  if (record.status !== "pending" && record.status !== "snoozed") {
    return undefined;
  }
  const commitmentsDb = getNodeSqliteKysely<CommitmentsDatabase>(db);
  const candidates = executeSqliteQuerySync(
    db,
    commitmentsDb
      .selectFrom("commitments")
      .selectAll()
      .where("agent_id", "=", record.agentId)
      .where("session_key", "=", record.sessionKey)
      .where("channel", "=", record.channel)
      .where("dedupe_key", "=", record.dedupeKey)
      .where("status", "in", [...ACTIVE_STATUSES])
      .orderBy("updated_at_ms", "desc")
      .orderBy("id", "asc"),
  ).rows;
  return candidates.find((candidate) =>
    sameLogicalScope(commitmentRecordFromRow(candidate), record),
  );
}

function updateCommitmentRow(db: DatabaseSync, record: CommitmentRecord): void {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<CommitmentsDatabase>(db)
      .updateTable("commitments")
      .set(commitmentRecordToUpdate(record))
      .where("id", "=", record.id),
  );
}

function restoreClaimAfterCleanupFailure(claimPath: string, sourcePath: string): string | null {
  if (!fs.existsSync(claimPath) || fs.existsSync(sourcePath)) {
    return null;
  }
  try {
    fs.renameSync(claimPath, sourcePath);
    return null;
  } catch (error) {
    return `; claimed source remains at ${claimPath} because restore also failed: ${String(error)}`;
  }
}

function claimAndRemoveSource(params: {
  sourcePath: string;
  snapshot: LegacySourceSnapshot;
  beforeClaim?: () => void;
  removeSource?: (sourcePath: string) => void;
}): void {
  params.beforeClaim?.();
  const claimPath = `${params.sourcePath}.doctor-importing-${process.pid}-${randomUUID()}`;
  fs.renameSync(params.sourcePath, claimPath);
  try {
    const claimed = readLegacySourceSnapshot(claimPath);
    if (!sourceSnapshotsMatch(claimed, params.snapshot)) {
      throw new Error("legacy commitments source changed before doctor could claim it");
    }
    (params.removeSource ?? fs.unlinkSync)(claimPath);
  } catch (error) {
    const restoreFailure = restoreClaimAfterCleanupFailure(claimPath, params.sourcePath);
    throw new Error(`${String(error)}${restoreFailure ?? ""}`, { cause: error });
  }
}

/** Import, verify, and remove the retired JSON store during explicit doctor repair. */
export function migrateLegacyCommitments(params: {
  detected: LegacyStateDetection["commitments"];
  stateDir: string;
  beforeClaim?: () => void;
  beforeVerify?: () => void;
  removeSource?: (sourcePath: string) => void;
}): MigrationMessages {
  const changes: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  if (!params.detected.hasLegacy) {
    return { changes, warnings };
  }

  let snapshot: LegacySourceSnapshot;
  let legacyRecords: CommitmentRecord[];
  try {
    snapshot = readLegacySourceSnapshot(params.detected.sourcePath);
    legacyRecords = parseLegacyCommitments(snapshot.raw);
  } catch (error) {
    warnings.push(
      `Failed reading legacy commitments state ${params.detected.sourcePath}: ${String(error)}`,
    );
    return { changes, warnings };
  }

  const expectedRows = new Map<string, CommitmentRecord>();
  let importedCount = 0;
  let newerSqliteCount = 0;
  let activeDuplicateCount = 0;
  try {
    assertLegacySourceUnchanged(params.detected.sourcePath, snapshot);
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const commitmentsDb = getNodeSqliteKysely<CommitmentsDatabase>(db);
        for (const legacyRecord of legacyRecords) {
          const existingRow = executeSqliteQueryTakeFirstSync(
            db,
            commitmentsDb.selectFrom("commitments").selectAll().where("id", "=", legacyRecord.id),
          );
          if (existingRow) {
            const existing = commitmentRecordFromRow(existingRow);
            if (
              commitmentImmutableIdentity(existing) !== commitmentImmutableIdentity(legacyRecord)
            ) {
              throw new Error(`commitment ${legacyRecord.id} has conflicting immutable identity`);
            }
            if (existing.updatedAtMs > legacyRecord.updatedAtMs) {
              expectedRows.set(existing.id, existing);
              newerSqliteCount += 1;
              continue;
            }
            if (existing.updatedAtMs === legacyRecord.updatedAtMs) {
              if (!commitmentRecordsEqual(existing, legacyRecord)) {
                throw new Error(
                  `commitment ${legacyRecord.id} diverges between JSON and SQLite at the same timestamp`,
                );
              }
              expectedRows.set(existing.id, existing);
              continue;
            }
            updateCommitmentRow(db, legacyRecord);
            expectedRows.set(legacyRecord.id, legacyRecord);
            importedCount += 1;
            continue;
          }

          const activeLogicalRow = findActiveLogicalRow(db, legacyRecord);
          if (activeLogicalRow) {
            const activeRecord = commitmentRecordFromRow(activeLogicalRow);
            expectedRows.set(activeRecord.id, activeRecord);
            activeDuplicateCount += 1;
            continue;
          }
          executeSqliteQuerySync(
            db,
            commitmentsDb.insertInto("commitments").values(commitmentRecordToRow(legacyRecord)),
          );
          expectedRows.set(legacyRecord.id, legacyRecord);
          importedCount += 1;
        }
      },
      { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } },
    );
  } catch (error) {
    warnings.push(`Failed migrating legacy commitments state: ${String(error)}`);
    return { changes, warnings };
  }

  try {
    params.beforeVerify?.();
    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir },
    });
    const commitmentsDb = getNodeSqliteKysely<CommitmentsDatabase>(database.db);
    for (const expected of expectedRows.values()) {
      const row = executeSqliteQueryTakeFirstSync(
        database.db,
        commitmentsDb.selectFrom("commitments").selectAll().where("id", "=", expected.id),
      );
      if (!row || !commitmentRecordsEqual(commitmentRecordFromRow(row), expected)) {
        throw new Error(`SQLite verification failed for commitment ${expected.id}`);
      }
    }
    assertLegacySourceUnchanged(params.detected.sourcePath, snapshot);
  } catch (error) {
    warnings.push(`Failed verifying legacy commitments migration: ${String(error)}`);
    return { changes, warnings };
  }

  try {
    claimAndRemoveSource({
      sourcePath: params.detected.sourcePath,
      snapshot,
      beforeClaim: params.beforeClaim,
      removeSource: params.removeSource,
    });
  } catch (error) {
    warnings.push(
      `Migrated commitments but could not remove legacy source ${params.detected.sourcePath}: ${String(error)}`,
    );
    return { changes, warnings };
  }

  if (importedCount > 0) {
    changes.push(`Migrated ${importedCount} commitment(s) → shared SQLite state`);
  }
  changes.push("Removed legacy commitments JSON after SQLite verification");
  if (newerSqliteCount > 0) {
    notices.push(`Kept ${newerSqliteCount} newer shared SQLite commitment(s) over legacy JSON`);
  }
  if (activeDuplicateCount > 0) {
    notices.push(
      `Kept ${activeDuplicateCount} canonical active SQLite commitment(s) over legacy logical duplicates`,
    );
  }
  return notices.length > 0 ? { changes, warnings, notices } : { changes, warnings };
}
