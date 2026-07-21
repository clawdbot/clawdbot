import type { OpenClawConfig } from "../../../config/types.openclaw.js";
// Fail-closed orchestration for legacy main session migrations outside doctor.
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../../infra/kysely-sync.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import type { DB as OpenClawStateDatabase } from "../../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../../state/openclaw-state-db.js";
import { maybeMigrateLegacyDefaultMainSessionKeys } from "./legacy-main-session-keys.js";
import { maybeMigrateLegacyMainSessionSqlite } from "./legacy-main-session-sqlite.js";

const LEGACY_IMPLICIT_AGENT_ID = "main";
const FIRST_AGENT_DEFAULT_INTENT_RUN_ID = "agent-roster:legacy-main-first-agent-default";
type MigrationRunDatabase = Pick<OpenClawStateDatabase, "migration_runs">;

export function isLegacyImplicitMainOnlyRoster(config: OpenClawConfig): boolean {
  const list = config.agents?.list ?? [];
  return (
    list.length === 1 &&
    normalizeAgentId(list[0]?.id ?? "") === LEGACY_IMPLICIT_AGENT_ID &&
    list[0]?.default === true
  );
}

type PendingIntent = { pending: boolean; agentId?: string };

function readIntentFromDatabase(db: import("node:sqlite").DatabaseSync): PendingIntent {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<MigrationRunDatabase>(db)
      .selectFrom("migration_runs")
      .select(["status", "report_json"])
      .where("id", "=", FIRST_AGENT_DEFAULT_INTENT_RUN_ID),
  );
  if (row?.status !== "pending") {
    return { pending: false };
  }
  try {
    const report = JSON.parse(row.report_json) as { agentId?: unknown };
    return {
      pending: true,
      ...(typeof report.agentId === "string" ? { agentId: normalizeAgentId(report.agentId) } : {}),
    };
  } catch {
    return { pending: true };
  }
}

export function recordLegacyMainFirstAgentDefaultIntent(): void {
  const now = Date.now();
  runOpenClawStateWriteTransaction(({ db }) => {
    if (readIntentFromDatabase(db).pending) {
      return;
    }
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<MigrationRunDatabase>(db)
        .insertInto("migration_runs")
        .values({
          id: FIRST_AGENT_DEFAULT_INTENT_RUN_ID,
          started_at: now,
          finished_at: null,
          status: "pending",
          report_json: "{}",
        })
        .onConflict((conflict) =>
          conflict.column("id").doUpdateSet({
            started_at: now,
            finished_at: null,
            status: "pending",
            report_json: "{}",
          }),
        ),
    );
  });
}

export function readPendingLegacyMainFirstAgentDefaultIntent(): string | undefined {
  const database = openOpenClawStateDatabase();
  return readIntentFromDatabase(database.db).agentId;
}

export function hasPendingLegacyMainFirstAgentDefaultIntent(agentId?: string): boolean {
  const intent = readIntentFromDatabase(openOpenClawStateDatabase().db);
  return agentId ? intent.pending && intent.agentId === normalizeAgentId(agentId) : intent.pending;
}

export function claimLegacyMainFirstAgentDefaultIntent(agentId: string): boolean {
  const normalizedAgentId = normalizeAgentId(agentId);
  return runOpenClawStateWriteTransaction(({ db }) => {
    const intent = readIntentFromDatabase(db);
    if (!intent.pending) {
      return false;
    }
    if (normalizedAgentId === LEGACY_IMPLICIT_AGENT_ID) {
      if (intent.agentId && intent.agentId !== LEGACY_IMPLICIT_AGENT_ID) {
        return false;
      }
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<MigrationRunDatabase>(db)
          .updateTable("migration_runs")
          .set({ finished_at: Date.now(), status: "completed" })
          .where("id", "=", FIRST_AGENT_DEFAULT_INTENT_RUN_ID),
      );
      return false;
    }
    if (intent.agentId && intent.agentId !== normalizedAgentId) {
      throw new Error(`Legacy first-agent creation is already claimed by "${intent.agentId}".`);
    }
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<MigrationRunDatabase>(db)
        .updateTable("migration_runs")
        .set({ report_json: JSON.stringify({ agentId: normalizedAgentId }) })
        .where("id", "=", FIRST_AGENT_DEFAULT_INTENT_RUN_ID),
    );
    return true;
  });
}

export function completeLegacyMainFirstAgentDefaultIntent(): void {
  if (!hasPendingLegacyMainFirstAgentDefaultIntent()) {
    return;
  }
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<MigrationRunDatabase>(db)
        .updateTable("migration_runs")
        .set({ finished_at: Date.now(), status: "completed" })
        .where("id", "=", FIRST_AGENT_DEFAULT_INTENT_RUN_ID),
    );
  });
}

export function reconcileLegacyMainFirstAgentDefaultIntent(config: OpenClawConfig): void {
  const pendingAgentId = readPendingLegacyMainFirstAgentDefaultIntent();
  if (
    pendingAgentId &&
    (config.agents?.list ?? []).some((entry) => normalizeAgentId(entry.id) === pendingAgentId)
  ) {
    completeLegacyMainFirstAgentDefaultIntent();
  }
}

export async function migrateLegacyMainSessionStateOrThrow(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ changed: boolean }> {
  const sqlite = await maybeMigrateLegacyMainSessionSqlite(config, env);
  const keys = await maybeMigrateLegacyDefaultMainSessionKeys(config, env);
  const warnings = [...sqlite.warnings, ...keys.warnings];
  if (warnings.length > 0) {
    throw new Error(`Legacy main session migration requires repair: ${warnings.join(" ")}`);
  }
  return { changed: sqlite.changes.length > 0 || keys.changes.length > 0 };
}
