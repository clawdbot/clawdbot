// Doctor-only import for the retired TUI last-session JSON store.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
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

type TuiLastSessionMigrationDatabase = Pick<OpenClawStateKyselyDatabase, "tui_last_sessions">;

type LegacyTuiLastSession = {
  scopeKey: string;
  sessionKey: string;
  updatedAt: number;
};

type LegacySourceSnapshot = {
  dev: number;
  ino: number;
  mtimeMs: number;
  raw: string;
  sha256: string;
  size: number;
};

const LEGACY_RECORD_KEYS = new Set(["sessionKey", "updatedAt"]);

function resolveLegacyTuiLastSessionPath(stateDir: string): string {
  return path.join(stateDir, "tui", "last-session.json");
}

/** Detect retired TUI state only when an explicit doctor flow opts in. */
export function detectLegacyTuiLastSessions(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyStateDetection["tuiLastSessions"] {
  const sourcePath = resolveLegacyTuiLastSessionPath(params.stateDir);
  return {
    sourcePath,
    hasLegacy: params.doctorOnlyStateMigrations === true && fs.existsSync(sourcePath),
  };
}

function readLegacySourceSnapshot(sourcePath: string): LegacySourceSnapshot {
  const before = fs.statSync(sourcePath);
  if (!before.isFile()) {
    throw new Error("legacy TUI last-session source is not a regular file");
  }
  const raw = fs.readFileSync(sourcePath, "utf8");
  const after = fs.statSync(sourcePath);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error("legacy TUI last-session source changed while doctor was reading it");
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

function assertLegacySourceUnchanged(sourcePath: string, expected: LegacySourceSnapshot): void {
  const current = readLegacySourceSnapshot(sourcePath);
  if (!legacySourceSnapshotsMatch(current, expected)) {
    throw new Error("legacy TUI last-session source changed after doctor loaded it");
  }
}

function legacySourceSnapshotsMatch(
  current: LegacySourceSnapshot,
  expected: LegacySourceSnapshot,
): boolean {
  return (
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.size === expected.size &&
    current.mtimeMs === expected.mtimeMs &&
    current.sha256 === expected.sha256
  );
}

function restoreClaimAfterCleanupFailure(params: {
  claimPath: string;
  sourcePath: string;
}): string | null {
  if (!fs.existsSync(params.claimPath) || fs.existsSync(params.sourcePath)) {
    return null;
  }
  try {
    fs.renameSync(params.claimPath, params.sourcePath);
    return null;
  } catch (error) {
    return `; the claimed source remains at ${params.claimPath} because restore also failed: ${String(error)}`;
  }
}

function claimAndRemoveVerifiedLegacySource(params: {
  sourcePath: string;
  snapshot: LegacySourceSnapshot;
  beforeClaim?: () => void;
  removeSource?: (sourcePath: string) => void;
}): void {
  params.beforeClaim?.();
  const claimPath = `${params.sourcePath}.doctor-importing-${process.pid}-${randomUUID()}`;
  fs.renameSync(params.sourcePath, claimPath);
  try {
    const claimedSnapshot = readLegacySourceSnapshot(claimPath);
    if (!legacySourceSnapshotsMatch(claimedSnapshot, params.snapshot)) {
      throw new Error("legacy TUI last-session source changed before doctor could claim it");
    }
    (params.removeSource ?? fs.unlinkSync)(claimPath);
  } catch (error) {
    const restoreFailure = restoreClaimAfterCleanupFailure({
      claimPath,
      sourcePath: params.sourcePath,
    });
    throw new Error(`${String(error)}${restoreFailure ?? ""}`, { cause: error });
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHeartbeatSessionKey(sessionKey: string): boolean {
  return sessionKey.toLowerCase().endsWith(":heartbeat");
}

function parseLegacyTuiLastSessions(raw: string): LegacyTuiLastSession[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!isObjectRecord(parsed)) {
    throw new Error("legacy TUI last-session store must be a JSON object");
  }
  const records: LegacyTuiLastSession[] = [];
  for (const [scopeKey, value] of Object.entries(parsed)) {
    if (!scopeKey || scopeKey.trim() !== scopeKey) {
      throw new Error("legacy TUI last-session store contains an invalid scope key");
    }
    if (!isObjectRecord(value)) {
      throw new Error(`legacy TUI last-session record ${scopeKey} must be an object`);
    }
    const unexpectedKey = Object.keys(value).find((key) => !LEGACY_RECORD_KEYS.has(key));
    if (unexpectedKey) {
      throw new Error(
        `legacy TUI last-session record ${scopeKey} has unexpected field ${unexpectedKey}`,
      );
    }
    const sessionKey = value.sessionKey;
    const updatedAt = value.updatedAt;
    if (
      typeof sessionKey !== "string" ||
      !sessionKey ||
      sessionKey.trim() !== sessionKey ||
      sessionKey === "unknown"
    ) {
      throw new Error(`legacy TUI last-session record ${scopeKey} has an invalid session key`);
    }
    if (!Number.isSafeInteger(updatedAt) || (updatedAt as number) < 0) {
      throw new Error(`legacy TUI last-session record ${scopeKey} has an invalid timestamp`);
    }
    records.push({ scopeKey, sessionKey, updatedAt: updatedAt as number });
  }
  return records;
}

function rowMatches(
  row: { session_key: string; updated_at: number } | undefined,
  expected: LegacyTuiLastSession,
): boolean {
  return row?.session_key === expected.sessionKey && row.updated_at === expected.updatedAt;
}

/** Import, verify, and remove the retired JSON store during an explicit doctor repair. */
export function migrateLegacyTuiLastSessions(params: {
  detected: LegacyStateDetection["tuiLastSessions"];
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
  let records: LegacyTuiLastSession[];
  try {
    snapshot = readLegacySourceSnapshot(params.detected.sourcePath);
    records = parseLegacyTuiLastSessions(snapshot.raw);
  } catch (error) {
    warnings.push(
      `Failed reading legacy TUI last-session state ${params.detected.sourcePath}: ${String(error)}`,
    );
    return { changes, warnings };
  }

  const activeRecords = records.filter((record) => !isHeartbeatSessionKey(record.sessionKey));
  const discardedHeartbeatCount = records.length - activeRecords.length;
  const expectedRows = new Map<string, LegacyTuiLastSession>();
  let importedCount = 0;
  let supersededCount = 0;
  try {
    // No filesystem work belongs inside the synchronous SQLite commit section.
    assertLegacySourceUnchanged(params.detected.sourcePath, snapshot);
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const tuiDb = getNodeSqliteKysely<TuiLastSessionMigrationDatabase>(db);
        for (const record of activeRecords) {
          const existing = executeSqliteQueryTakeFirstSync(
            db,
            tuiDb
              .selectFrom("tui_last_sessions")
              .select(["session_key", "updated_at"])
              .where("scope_key", "=", record.scopeKey),
          );
          if (!existing) {
            executeSqliteQuerySync(
              db,
              tuiDb.insertInto("tui_last_sessions").values({
                scope_key: record.scopeKey,
                session_key: record.sessionKey,
                updated_at: record.updatedAt,
              }),
            );
            expectedRows.set(record.scopeKey, record);
            importedCount += 1;
            continue;
          }
          if (existing.updated_at === record.updatedAt) {
            if (existing.session_key !== record.sessionKey) {
              throw new Error(
                `scope ${record.scopeKey} has divergent JSON and SQLite pointers at the same timestamp`,
              );
            }
            expectedRows.set(record.scopeKey, record);
            continue;
          }
          if (existing.updated_at > record.updatedAt) {
            expectedRows.set(record.scopeKey, {
              scopeKey: record.scopeKey,
              sessionKey: existing.session_key,
              updatedAt: existing.updated_at,
            });
            supersededCount += 1;
            continue;
          }
          executeSqliteQuerySync(
            db,
            tuiDb
              .updateTable("tui_last_sessions")
              .set({ session_key: record.sessionKey, updated_at: record.updatedAt })
              .where("scope_key", "=", record.scopeKey),
          );
          expectedRows.set(record.scopeKey, record);
          importedCount += 1;
        }
      },
      { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } },
    );
  } catch (error) {
    warnings.push(`Failed migrating legacy TUI last-session state: ${String(error)}`);
    return { changes, warnings };
  }

  try {
    params.beforeVerify?.();
    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir },
    });
    const tuiDb = getNodeSqliteKysely<TuiLastSessionMigrationDatabase>(database.db);
    for (const expected of expectedRows.values()) {
      const row = executeSqliteQueryTakeFirstSync(
        database.db,
        tuiDb
          .selectFrom("tui_last_sessions")
          .select(["session_key", "updated_at"])
          .where("scope_key", "=", expected.scopeKey),
      );
      if (!rowMatches(row, expected)) {
        throw new Error(`SQLite verification failed for scope ${expected.scopeKey}`);
      }
    }
    assertLegacySourceUnchanged(params.detected.sourcePath, snapshot);
  } catch (error) {
    warnings.push(`Failed verifying legacy TUI last-session migration: ${String(error)}`);
    return { changes, warnings };
  }

  try {
    claimAndRemoveVerifiedLegacySource({
      sourcePath: params.detected.sourcePath,
      snapshot,
      beforeClaim: params.beforeClaim,
      removeSource: params.removeSource,
    });
  } catch (error) {
    warnings.push(
      `Migrated TUI last-session state but could not remove legacy source ${params.detected.sourcePath}: ${String(error)}`,
    );
    return { changes, warnings };
  }

  if (importedCount > 0) {
    changes.push(`Migrated ${importedCount} TUI last-session pointer(s) → shared SQLite state`);
  }
  if (discardedHeartbeatCount > 0) {
    changes.push(`Discarded ${discardedHeartbeatCount} legacy heartbeat TUI restore pointer(s)`);
  }
  changes.push("Removed legacy TUI last-session JSON after SQLite verification");
  if (supersededCount > 0) {
    notices.push(
      `Kept ${supersededCount} newer shared SQLite TUI last-session pointer(s) over legacy JSON`,
    );
  }
  return notices.length > 0 ? { changes, warnings, notices } : { changes, warnings };
}
