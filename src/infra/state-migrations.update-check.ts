import path from "node:path";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { migrateLegacyJsonState } from "./state-migrations.runtime-state.js";
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";

type LegacyUpdateCheckImportDatabase = Pick<OpenClawStateKyselyDatabase, "update_check_state">;

const UPDATE_CHECK_STATE_KEY = "default";
const UPDATE_CHECK_STATE_FIELDS = [
  ["lastCheckedAt", "last_checked_at"],
  ["lastNotifiedVersion", "last_notified_version"],
  ["lastNotifiedTag", "last_notified_tag"],
  ["lastAvailableVersion", "last_available_version"],
  ["lastAvailableTag", "last_available_tag"],
  ["autoInstallId", "auto_install_id"],
  ["autoFirstSeenVersion", "auto_first_seen_version"],
  ["autoFirstSeenTag", "auto_first_seen_tag"],
  ["autoFirstSeenAt", "auto_first_seen_at"],
  ["autoLastAttemptVersion", "auto_last_attempt_version"],
  ["autoLastAttemptAt", "auto_last_attempt_at"],
  ["autoLastSuccessVersion", "auto_last_success_version"],
  ["autoLastSuccessAt", "auto_last_success_at"],
] as const;
type LegacyUpdateCheckState = Partial<
  Record<(typeof UPDATE_CHECK_STATE_FIELDS)[number][0], string>
>;
type LegacyUpdateCheckRow = Record<(typeof UPDATE_CHECK_STATE_FIELDS)[number][1], string | null>;

export function resolveLegacyUpdateCheckPath(stateDir: string): string {
  return path.join(stateDir, "update-check.json");
}

function normalizeLegacyUpdateCheckState(input: unknown): LegacyUpdateCheckState {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return Object.fromEntries(
    UPDATE_CHECK_STATE_FIELDS.map(([field]) => {
      const value = record[field];
      return [field, typeof value === "string" && value.trim().length > 0 ? value : undefined];
    }),
  ) as LegacyUpdateCheckState;
}

function legacyUpdateCheckStateMatches(
  row: LegacyUpdateCheckRow,
  state: LegacyUpdateCheckState,
): boolean {
  return UPDATE_CHECK_STATE_FIELDS.every(
    ([field, column]) => (state[field] ?? null) === row[column],
  );
}

export function migrateLegacyUpdateCheckState(params: {
  detected: LegacyStateDetection["updateCheck"];
  stateDir: string;
}): MigrationMessages {
  return migrateLegacyJsonState({
    sourcePath: params.detected.sourcePath,
    stateDir: params.stateDir,
    label: "update-check state",
    normalize: normalizeLegacyUpdateCheckState,
    migrate(db, state) {
      const stateDb = getNodeSqliteKysely<LegacyUpdateCheckImportDatabase>(db);
      const existing = executeSqliteQueryTakeFirstSync(
        db,
        stateDb
          .selectFrom("update_check_state")
          .selectAll()
          .where("state_key", "=", UPDATE_CHECK_STATE_KEY),
      );
      if (existing) {
        return {
          changes: [],
          ...(legacyUpdateCheckStateMatches(existing, state)
            ? {}
            : {
                notices: [
                  `Kept shared SQLite update-check state because legacy cache differs: ${params.detected.sourcePath}`,
                ],
              }),
        };
      }
      const columns = Object.fromEntries(
        UPDATE_CHECK_STATE_FIELDS.map(([field, column]) => [column, state[field] ?? null]),
      ) as LegacyUpdateCheckRow;
      executeSqliteQuerySync(
        db,
        stateDb.insertInto("update_check_state").values({
          state_key: UPDATE_CHECK_STATE_KEY,
          ...columns,
          updated_at_ms: Date.now(),
        }),
      );
      return { changes: ["Migrated update-check state → shared SQLite state"] };
    },
  });
}
