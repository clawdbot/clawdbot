/** Offline destination ownership and conservative adoption of historical import evidence. */
import fs from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { withSqliteSessionImportStage } from "../config/sessions/session-accessor.sqlite-import-stage.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import { readFileDescriptorBoundedSync } from "../infra/boundary-file-read.js";
import { executeSqliteQueryTakeFirstSync, iterateSqliteQuerySync } from "../infra/kysely-sync.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { normalizeLegacySessionEntryDelivery } from "../infra/state-migrations.legacy-session-store.js";
import { migrateLegacySessionCreator } from "../state/creator-namespace-migration.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { inspectOpenClawAgentDatabaseOwner } from "../state/openclaw-agent-db.js";
import {
  readMigrationArtifactIdentity,
  type MigrationArtifact,
} from "./doctor-session-sqlite-artifact.js";
import {
  canonicalMigrationFilePath,
  uniqueRestoreMoves,
  type SessionSqliteMigrationMove,
  type SessionSqliteMigrationTargetManifest,
} from "./doctor-session-sqlite-migration-run.js";
import {
  createTranscriptEventReader,
  readTranscriptFingerprint,
  resolveLegacyTranscriptPaths,
} from "./doctor-session-sqlite-readers.js";
import { assertDoctorSqliteMaintenancePathsNotAliased } from "./doctor-sqlite-maintenance-lock.js";

/** Keep one owner proof per database; fence in-place writes and sidecar changes after awaits. */
export function createRecoveryDestinationVerifier(stateDir: string) {
  const destinations = new Map<
    string,
    { agentId: string; files: (fs.BigIntStats | undefined)[] }
  >();
  return (refs: Iterable<{ target: SessionSqliteMigrationTargetManifest }>) => {
    for (const { target } of refs) {
      const paths = resolveSqliteDatabaseFilePaths(target.sqlitePath);
      assertDoctorSqliteMaintenancePathsNotAliased("update recovery cleanup", paths, [stateDir]);
      const expected = destinations.get(target.sqlitePath);
      if (!expected) {
        const owner = inspectOpenClawAgentDatabaseOwner(target.sqlitePath);
        if (owner.status !== "owned" || owner.agentId !== target.agentId) {
          throw new Error("destination database ownership cannot be verified");
        }
      }
      // Even a read-only SQLite connection can create WAL/SHM files. Establish the baseline
      // after owner inspection closes it; later checks only stat, never reopen or hash the DB.
      const files = paths.map((file) =>
        fs.lstatSync(file, { bigint: true, throwIfNoEntry: false }),
      );
      if (
        !files[0]?.isFile() ||
        files.some((file) => file && (!file.isFile() || file.nlink !== 1n)) ||
        (expected &&
          (expected.agentId !== target.agentId ||
            files.some((file, index) =>
              (["dev", "ino", "ctimeNs", "mtimeNs", "size"] as const).some(
                (key) => file?.[key] !== expected.files[index]?.[key],
              ),
            )))
      ) {
        throw new Error("Recovery destination database changed; preview cleanup again.");
      }
      if (!expected) {
        destinations.set(target.sqlitePath, { agentId: target.agentId, files });
      }
    }
  };
}

export function verifyHistoricalMigrationArtifact(params: {
  target: SessionSqliteMigrationTargetManifest;
  move: SessionSqliteMigrationMove;
  env: NodeJS.ProcessEnv;
}): MigrationArtifact | undefined {
  const { target, move, env } = params;
  if (move.kind !== "legacy-store" && move.kind !== "transcript") {
    return undefined;
  }
  const identity = readMigrationArtifactIdentity(move.archivePath);
  const indexMove =
    move.kind === "legacy-store"
      ? move
      : uniqueRestoreMoves(target).find((item) => item.kind === "legacy-store");
  if (!indexMove) {
    return undefined;
  }
  readMigrationArtifactIdentity(indexMove.archivePath);
  const fd = fs.openSync(
    indexMove.archivePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  let index: unknown;
  try {
    index = JSON.parse(readFileDescriptorBoundedSync(fd, fs.fstatSync(fd).size).toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
  if (!isRecord(index)) {
    return undefined;
  }
  const entries =
    move.kind === "legacy-store"
      ? Object.entries(index)
      : move.sessionKey
        ? [[move.sessionKey, index[move.sessionKey]]]
        : [];
  if (move.kind === "transcript" && entries.length !== 1) {
    return undefined;
  }
  const dependencies = new Set(
    move.kind === "legacy-store"
      ? uniqueRestoreMoves(target)
          .filter((item) => item.kind === "transcript")
          .map((item) => item.sourcePath)
      : [],
  );
  const verified = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      const db = getSessionKysely(database.db);
      for (const [key, raw] of entries) {
        if (
          typeof key !== "string" ||
          !isRecord(raw) ||
          typeof raw.sessionId !== "string" ||
          !raw.sessionId.trim() ||
          typeof raw.updatedAt !== "number"
        ) {
          return false;
        }
        const sessionId = raw.sessionId;
        const row = executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("session_nodes")
            .select(["current_session_id", "entry_json"])
            .where("session_key", "=", key),
        );
        if (!row || row.current_session_id !== raw.sessionId) {
          return false;
        }
        const current: unknown = JSON.parse(row.entry_json);
        const entry = { ...raw, sessionId, updatedAt: raw.updatedAt };
        const normalized = migrateLegacySessionCreator(normalizeLegacySessionEntryDelivery(entry));
        if (
          !isRecord(current) ||
          Object.entries(normalized).some(
            ([field, value]) =>
              field !== "sessionFile" && JSON.stringify(current[field]) !== JSON.stringify(value),
          )
        ) {
          return false;
        }
        if (move.kind !== "transcript") {
          // Historical indexes can refer to transcripts published by an earlier run.
          // Reuse the producer's path contract rather than requiring same-run moves.
          for (const source of resolveLegacyTranscriptPaths(target, entry).transcriptDependencies) {
            dependencies.add(canonicalMigrationFilePath(source));
          }
          continue;
        }
        const complete = withSqliteSessionImportStage((stage) => {
          let seq = 0;
          const validate = createTranscriptEventReader(
            move.archivePath,
            sessionId,
            false,
            readTranscriptFingerprint(move.archivePath),
            move.sourcePath,
          )((event) => stage.append(0, seq++, JSON.stringify(event), null));
          const repair = stage.repairLegacyTranscript(0);
          // Old metadata cannot prove that a now-discarded branch was deliberately retired then.
          if (repair.repaired || !repair.recognized) {
            return false;
          }
          for (const event of iterateSqliteQuerySync(
            database.db,
            db
              .selectFrom("transcript_events")
              .select("event_json")
              .where("session_id", "=", sessionId),
          )) {
            stage.addSeen(event.event_json);
          }
          for (const event of stage.rows(0)) {
            if (!stage.contains(event.eventJson)) {
              return false;
            }
          }
          validate();
          return true;
        });
        if (!complete) {
          return false;
        }
      }
      return true;
    },
    { agentId: target.agentId, path: target.sqlitePath, env },
  );
  if (!verified.found || !verified.value) {
    return undefined;
  }
  return {
    identity,
    classification: "imported",
    reason: "verified-historical-import",
    dependencies: [...dependencies],
    disposal: { state: "retained" },
  };
}
