import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parse as parseSemver } from "semver";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { ABANDONED_UPDATE_RUN_MS } from "../infra/update-run-timeouts.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { CONTENT_VERSION_KEY } from "./openclaw-state-db-schema-version.js";
import type { DB } from "./openclaw-state-db.generated.js";

const TERMINAL_GRACE_MS = 5 * 60_000;
type PublicationDatabase = Pick<DB, "config_machine_state" | "update_runs">;

export type StateSchemaPublicationBlocker = {
  runId: string;
  updaterVersion: string;
  publishAfterMs: number | null;
};

/** Only the 2026.9.2 release line reopens the ledger without the transaction fence. */
function isUnfencedUpdateDriver(version: unknown): boolean {
  const parsed = typeof version === "string" ? parseSemver(version) : null;
  return parsed !== null && `${parsed.major}.${parsed.minor}.${parsed.patch}` === "2026.9.2";
}

/** Every unfenced driver must clear its own deadline; a newer run cannot hide an older one. */
export function readStateSchemaPublicationBlocker(
  db: DatabaseSync,
  nowMs = Date.now(),
): StateSchemaPublicationBlocker | undefined {
  if (!tableExists(db, "update_runs")) {
    return undefined;
  }
  const rows = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<PublicationDatabase>(db)
      .selectFrom("update_runs")
      .select(["run_id", "before_json", "status", "updated_at_ms", "finished_at_ms"])
      .where((eb) =>
        eb.or([
          eb.and([
            eb("status", "=", "running"),
            eb("updated_at_ms", ">=", nowMs - ABANDONED_UPDATE_RUN_MS),
          ]),
          eb.and([
            eb("status", "!=", "running"),
            eb.or([
              eb("finished_at_ms", ">", nowMs - TERMINAL_GRACE_MS),
              eb("finished_at_ms", "is", null),
            ]),
          ]),
        ]),
      )
      .orderBy("run_id"),
  ).rows;
  let blocker: StateSchemaPublicationBlocker | undefined;
  for (const row of rows) {
    const before: unknown = JSON.parse(row.before_json);
    if (
      !isRecord(before) ||
      typeof before.version !== "string" ||
      !isUnfencedUpdateDriver(before.version)
    ) {
      continue;
    }
    const deadline =
      row.status === "running"
        ? row.updated_at_ms + ABANDONED_UPDATE_RUN_MS + 1
        : row.finished_at_ms === null
          ? null
          : row.finished_at_ms + TERMINAL_GRACE_MS;
    if (
      !blocker ||
      deadline === null ||
      (blocker.publishAfterMs !== null && deadline > blocker.publishAfterMs)
    ) {
      blocker = { runId: row.run_id, updaterVersion: before.version, publishAfterMs: deadline };
    }
  }
  return blocker;
}

/** Called inside the schema write transaction, after all content migrations succeed. */
export function resolveStateSchemaVersionToPublish(db: DatabaseSync): number {
  const published = readSqliteUserVersion(db);
  if (published >= OPENCLAW_STATE_SCHEMA_VERSION || !readStateSchemaPublicationBlocker(db)) {
    return OPENCLAW_STATE_SCHEMA_VERSION;
  }
  if (!tableExists(db, "config_machine_state")) {
    throw new Error(
      "Shared state schema publication cannot be deferred without config_machine_state.",
    );
  }
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<PublicationDatabase>(db)
      .insertInto("config_machine_state")
      .values({
        state_key: CONTENT_VERSION_KEY,
        value_json: String(OPENCLAW_STATE_SCHEMA_VERSION),
        updated_at_ms: Date.now(),
      })
      .onConflict((conflict) =>
        conflict
          .column("state_key")
          .doUpdateSet({
            value_json: String(OPENCLAW_STATE_SCHEMA_VERSION),
            updated_at_ms: Date.now(),
          })
          .where("config_machine_state.value_json", "!=", String(OPENCLAW_STATE_SCHEMA_VERSION)),
      ),
  );
  return published;
}
