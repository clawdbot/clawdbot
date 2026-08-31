// Doctor-only import for the retired TUI last-session JSON store.
import fs from "node:fs";
import path from "node:path";
import { isRecord as isObjectRecord } from "@openclaw/normalization-core/record-coerce";
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
import {
  assertLegacyMigrationSourceUnchanged,
  claimAndRemoveLegacyMigrationSource,
  readLegacyMigrationSourceSnapshotSync,
  type LegacyMigrationSourceSnapshot as LegacySourceSnapshot,
} from "./state-migrations.source-snapshot.js";
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";

type TuiLastSessionMigrationDatabase = Pick<OpenClawStateKyselyDatabase, "config_machine_state">;

type LegacyTuiLastSession = {
  scopeKey: string;
  sessionKey: string;
  updatedAt: number;
};

const LEGACY_RECORD_KEYS = new Set(["sessionKey", "updatedAt"]);
const TUI_LAST_SESSION_STATE_KEY_PREFIX = "tui.lastSession.";

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
  return readLegacyMigrationSourceSnapshotSync({
    sourcePath,
    label: "TUI last-session",
    followSymlinks: true,
  });
}

function assertLegacySourceUnchanged(sourcePath: string, expected: LegacySourceSnapshot): void {
  assertLegacyMigrationSourceUnchanged({
    sourcePath,
    snapshot: expected,
    label: "TUI last-session",
    followSymlinks: true,
  });
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
  row: { value_json: string; updated_at_ms: number } | undefined,
  expected: LegacyTuiLastSession,
): boolean {
  return (
    row?.value_json === JSON.stringify(expected.sessionKey) &&
    row.updated_at_ms === expected.updatedAt
  );
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
          const stateKey = `${TUI_LAST_SESSION_STATE_KEY_PREFIX}${record.scopeKey}`;
          const existing = executeSqliteQueryTakeFirstSync(
            db,
            tuiDb
              .selectFrom("config_machine_state")
              .select(["value_json", "updated_at_ms"])
              .where("state_key", "=", stateKey),
          );
          if (!existing) {
            executeSqliteQuerySync(
              db,
              tuiDb.insertInto("config_machine_state").values({
                state_key: stateKey,
                value_json: JSON.stringify(record.sessionKey),
                updated_at_ms: record.updatedAt,
              }),
            );
            expectedRows.set(record.scopeKey, record);
            importedCount += 1;
            continue;
          }
          // SAFETY: The TUI owner stores each tui.lastSession value as a JSON string.
          const existingSessionKey = JSON.parse(existing.value_json) as string;
          if (existing.updated_at_ms === record.updatedAt) {
            if (existingSessionKey !== record.sessionKey) {
              throw new Error(
                `scope ${record.scopeKey} has divergent JSON and SQLite pointers at the same timestamp`,
              );
            }
            expectedRows.set(record.scopeKey, record);
            continue;
          }
          if (existing.updated_at_ms > record.updatedAt) {
            expectedRows.set(record.scopeKey, {
              scopeKey: record.scopeKey,
              sessionKey: existingSessionKey,
              updatedAt: existing.updated_at_ms,
            });
            supersededCount += 1;
            continue;
          }
          executeSqliteQuerySync(
            db,
            tuiDb
              .updateTable("config_machine_state")
              .set({
                value_json: JSON.stringify(record.sessionKey),
                updated_at_ms: record.updatedAt,
              })
              .where("state_key", "=", stateKey),
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
          .selectFrom("config_machine_state")
          .select(["value_json", "updated_at_ms"])
          .where("state_key", "=", `${TUI_LAST_SESSION_STATE_KEY_PREFIX}${expected.scopeKey}`),
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
    claimAndRemoveLegacyMigrationSource({
      sourcePath: params.detected.sourcePath,
      snapshot,
      label: "TUI last-session",
      followSymlinks: true,
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
