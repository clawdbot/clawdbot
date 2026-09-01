import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import type { ProgressCard, ProgressCardStep } from "../../packages/gateway-protocol/src/index.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { ensureOpenClawAgentProgressCardSchemaInTransaction } from "../state/openclaw-agent-progress-card-schema.js";

type ProgressCardDatabase = Pick<OpenClawAgentKyselyDatabase, "session_progress_cards">;
type ProgressCardDatabaseInput = string | DatabaseSync;
type StoredProgressCardRow = Selectable<ProgressCardDatabase["session_progress_cards"]>;

function withProgressCardDatabase<T>(
  input: ProgressCardDatabaseInput,
  readOnly: boolean,
  operation: (db: DatabaseSync, label: string) => T,
): T {
  if (typeof input !== "string") {
    return operation(input, "openclaw-agent.sqlite");
  }
  const db = openNodeSqliteDatabase(input, { readOnly });
  try {
    if (!readOnly) {
      db.exec("PRAGMA foreign_keys = ON;"); // sqlite-allow-raw -- Connection bootstrap before Kysely queries.
    }
    return operation(db, input);
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(db);
    db.close();
  }
}

function progressCardTablePresent(db: DatabaseSync): boolean {
  return Boolean(
    db // sqlite-allow-raw -- Catalog probe before Kysely table access on a read-only connection.
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_progress_cards'",
      )
      .get(),
  );
}

function selectProgressCard(db: DatabaseSync, sessionKey: string): StoredProgressCardRow | null {
  const kysely = getNodeSqliteKysely<ProgressCardDatabase>(db);
  return (
    executeSqliteQuerySync(
      db,
      kysely
        .selectFrom("session_progress_cards")
        .select(["session_key", "markdown", "steps_json", "revision", "created_at", "updated_at"])
        .where("session_key", "=", sessionKey)
        .limit(1),
    ).rows[0] ?? null
  );
}

function rowToProgressCard(row: StoredProgressCardRow): ProgressCard | null {
  const steps = row.steps_json ? readStoredSteps(row.steps_json) : undefined;
  if (!row.markdown && !steps?.length) {
    return null;
  }
  return {
    sessionKey: row.session_key,
    revision: row.revision,
    updatedAt: row.updated_at,
    ...(row.markdown ? { markdown: row.markdown } : {}),
    ...(steps && steps.length > 0 ? { steps } : {}),
  };
}

function readStoredSteps(value: string): ProgressCardStep[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error("stored progress-card steps are not an array");
  }
  return parsed.map((entry, index) => {
    const record = asOptionalObjectRecord(entry);
    if (!record) {
      throw new Error(`stored progress-card step ${index} is invalid`);
    }
    const { step, status } = record;
    if (
      typeof step !== "string" ||
      (status !== "pending" && status !== "in_progress" && status !== "completed")
    ) {
      throw new Error(`stored progress-card step ${index} is invalid`);
    }
    return { step, status };
  });
}

export function readSessionProgressCard(
  dbPathOrDb: ProgressCardDatabaseInput,
  sessionKey: string,
): ProgressCard | null {
  if (typeof dbPathOrDb === "string" && !fs.existsSync(dbPathOrDb)) {
    return null;
  }
  return withProgressCardDatabase(dbPathOrDb, true, (db) => {
    if (!progressCardTablePresent(db)) {
      return null;
    }
    const row = selectProgressCard(db, sessionKey);
    return row ? rowToProgressCard(row) : null;
  });
}

export function writeSessionProgressCard(
  dbPathOrDb: ProgressCardDatabaseInput,
  sessionKey: string,
  input: { markdown?: string; steps?: ProgressCardStep[]; expectedRevision?: number },
): { card: ProgressCard | null } | { cleared: true } {
  return withProgressCardDatabase(dbPathOrDb, false, (db, label) => {
    const write = (): { card: ProgressCard | null } | { cleared: true } => {
      ensureOpenClawAgentProgressCardSchemaInTransaction(db);
      const kysely = getNodeSqliteKysely<ProgressCardDatabase>(db);
      const markdown = input.markdown?.trim() ? input.markdown : undefined;
      const steps = input.steps && input.steps.length > 0 ? input.steps : undefined;
      if (!markdown && !steps) {
        const previous = selectProgressCard(db, sessionKey);
        if (input.expectedRevision !== undefined) {
          const current = previous ? rowToProgressCard(previous) : null;
          if (
            !previous ||
            previous.revision !== input.expectedRevision ||
            !current?.steps?.length ||
            current.steps.some((step) => step.status !== "completed")
          ) {
            return { card: current };
          }
        }
        if (previous) {
          executeSqliteQuerySync(
            db,
            kysely
              .updateTable("session_progress_cards")
              .set({
                markdown: null,
                steps_json: null,
                revision: previous.revision + 1,
                updated_at: Date.now(),
              })
              .where("session_key", "=", sessionKey),
          );
        }
        return { cleared: true };
      }
      const previous = selectProgressCard(db, sessionKey);
      const now = Date.now();
      const revision = (previous?.revision ?? 0) + 1;
      const stepsJson = steps ? JSON.stringify(steps) : null;
      executeSqliteQuerySync(
        db,
        kysely
          .insertInto("session_progress_cards")
          .values({
            session_key: sessionKey,
            markdown: markdown ?? null,
            steps_json: stepsJson,
            revision,
            created_at: previous?.created_at ?? now,
            updated_at: now,
          })
          .onConflict((conflict) =>
            conflict.column("session_key").doUpdateSet({
              markdown: markdown ?? null,
              steps_json: stepsJson,
              revision,
              updated_at: now,
            }),
          ),
      );
      return {
        card: {
          sessionKey,
          revision,
          updatedAt: now,
          ...(markdown ? { markdown } : {}),
          ...(steps ? { steps } : {}),
        },
      };
    };
    return db.isTransaction
      ? write()
      : runSqliteImmediateTransactionSync(db, write, {
          databaseLabel: label,
          operationLabel: "progress-card.write",
        });
  });
}
