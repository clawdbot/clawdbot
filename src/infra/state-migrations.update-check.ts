import fs from "node:fs";
import path from "node:path";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { fileExists } from "./state-migrations.fs.js";
import { archiveLegacyImportSource } from "./state-migrations.storage.js";
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";

type LegacyUpdateCheckImportDatabase = Pick<OpenClawStateKyselyDatabase, "update_check_state">;

type LegacyUpdateCheckState = {
  lastCheckedAt?: string;
  lastNotifiedVersion?: string;
  lastNotifiedTag?: string;
  lastAvailableVersion?: string;
  lastAvailableTag?: string;
  autoInstallId?: string;
  autoFirstSeenVersion?: string;
  autoFirstSeenTag?: string;
  autoFirstSeenAt?: string;
  autoLastAttemptVersion?: string;
  autoLastAttemptAt?: string;
  autoLastSuccessVersion?: string;
  autoLastSuccessAt?: string;
};

const UPDATE_CHECK_STATE_KEY = "default";

export function resolveLegacyUpdateCheckPath(stateDir: string): string {
  return path.join(stateDir, "update-check.json");
}

function normalizeLegacyUpdateCheckState(input: unknown): LegacyUpdateCheckState {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const readString = (key: string): string | undefined => {
    const value = record[key];
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
  };
  return {
    lastCheckedAt: readString("lastCheckedAt"),
    lastNotifiedVersion: readString("lastNotifiedVersion"),
    lastNotifiedTag: readString("lastNotifiedTag"),
    lastAvailableVersion: readString("lastAvailableVersion"),
    lastAvailableTag: readString("lastAvailableTag"),
    autoInstallId: readString("autoInstallId"),
    autoFirstSeenVersion: readString("autoFirstSeenVersion"),
    autoFirstSeenTag: readString("autoFirstSeenTag"),
    autoFirstSeenAt: readString("autoFirstSeenAt"),
    autoLastAttemptVersion: readString("autoLastAttemptVersion"),
    autoLastAttemptAt: readString("autoLastAttemptAt"),
    autoLastSuccessVersion: readString("autoLastSuccessVersion"),
    autoLastSuccessAt: readString("autoLastSuccessAt"),
  };
}

function legacyUpdateCheckStateMatches(
  row: {
    last_checked_at: string | null;
    last_notified_version: string | null;
    last_notified_tag: string | null;
    last_available_version: string | null;
    last_available_tag: string | null;
    auto_install_id: string | null;
    auto_first_seen_version: string | null;
    auto_first_seen_tag: string | null;
    auto_first_seen_at: string | null;
    auto_last_attempt_version: string | null;
    auto_last_attempt_at: string | null;
    auto_last_success_version: string | null;
    auto_last_success_at: string | null;
  },
  state: LegacyUpdateCheckState,
): boolean {
  return (
    (state.lastCheckedAt ?? null) === row.last_checked_at &&
    (state.lastNotifiedVersion ?? null) === row.last_notified_version &&
    (state.lastNotifiedTag ?? null) === row.last_notified_tag &&
    (state.lastAvailableVersion ?? null) === row.last_available_version &&
    (state.lastAvailableTag ?? null) === row.last_available_tag &&
    (state.autoInstallId ?? null) === row.auto_install_id &&
    (state.autoFirstSeenVersion ?? null) === row.auto_first_seen_version &&
    (state.autoFirstSeenTag ?? null) === row.auto_first_seen_tag &&
    (state.autoFirstSeenAt ?? null) === row.auto_first_seen_at &&
    (state.autoLastAttemptVersion ?? null) === row.auto_last_attempt_version &&
    (state.autoLastAttemptAt ?? null) === row.auto_last_attempt_at &&
    (state.autoLastSuccessVersion ?? null) === row.auto_last_success_version &&
    (state.autoLastSuccessAt ?? null) === row.auto_last_success_at
  );
}

export function migrateLegacyUpdateCheckState(params: {
  detected: LegacyStateDetection["updateCheck"];
  stateDir: string;
}): MigrationMessages {
  const changes: string[] = [];
  const warnings: string[] = [];
  let notice: string | undefined;
  if (!fileExists(params.detected.sourcePath)) {
    return { changes, warnings };
  }

  let state: LegacyUpdateCheckState;
  try {
    state = normalizeLegacyUpdateCheckState(
      JSON.parse(fs.readFileSync(params.detected.sourcePath, "utf8")) as unknown,
    );
  } catch (err) {
    warnings.push(
      `Failed reading legacy update-check state ${params.detected.sourcePath}: ${String(err)}`,
    );
    return { changes, warnings };
  }

  let imported = false;
  let shouldArchive = false;
  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const stateDb = getNodeSqliteKysely<LegacyUpdateCheckImportDatabase>(db);
        const existing = executeSqliteQueryTakeFirstSync(
          db,
          stateDb
            .selectFrom("update_check_state")
            .selectAll()
            .where("state_key", "=", UPDATE_CHECK_STATE_KEY),
        );
        if (existing) {
          if (!legacyUpdateCheckStateMatches(existing, state)) {
            // SQLite is the canonical cache; retaining divergent JSON would block every startup.
            notice = `Kept shared SQLite update-check state because legacy cache differs: ${params.detected.sourcePath}`;
          }
          shouldArchive = true;
          return;
        }
        executeSqliteQuerySync(
          db,
          stateDb.insertInto("update_check_state").values({
            state_key: UPDATE_CHECK_STATE_KEY,
            last_checked_at: state.lastCheckedAt ?? null,
            last_notified_version: state.lastNotifiedVersion ?? null,
            last_notified_tag: state.lastNotifiedTag ?? null,
            last_available_version: state.lastAvailableVersion ?? null,
            last_available_tag: state.lastAvailableTag ?? null,
            auto_install_id: state.autoInstallId ?? null,
            auto_first_seen_version: state.autoFirstSeenVersion ?? null,
            auto_first_seen_tag: state.autoFirstSeenTag ?? null,
            auto_first_seen_at: state.autoFirstSeenAt ?? null,
            auto_last_attempt_version: state.autoLastAttemptVersion ?? null,
            auto_last_attempt_at: state.autoLastAttemptAt ?? null,
            auto_last_success_version: state.autoLastSuccessVersion ?? null,
            auto_last_success_at: state.autoLastSuccessAt ?? null,
            updated_at_ms: Date.now(),
          }),
        );
        imported = true;
        shouldArchive = true;
      },
      { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } },
    );
  } catch (err) {
    warnings.push(`Failed migrating legacy update-check state: ${String(err)}`);
  }
  if (imported) {
    changes.push("Migrated update-check state → shared SQLite state");
  }
  if (shouldArchive) {
    archiveLegacyImportSource({
      sourcePath: params.detected.sourcePath,
      label: "update-check state",
      changes,
      warnings,
    });
  }
  return { changes, warnings, ...(notice ? { notices: [notice] } : {}) };
}
