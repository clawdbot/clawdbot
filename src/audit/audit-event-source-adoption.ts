import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { AuditEventInput } from "./audit-event-types.js";

type AuditDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "audit_events" | "audit_event_source_adoptions"
>;

const schemaEnsured = new WeakSet<DatabaseSync>();

function getAuditKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<AuditDatabase>(db);
}

function pruneOrphanedSourceAdoptions(db: DatabaseSync): void {
  const kysely = getAuditKysely(db);
  executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("audit_event_source_adoptions")
      .where((expression) =>
        expression.not(
          expression.exists(
            expression
              .selectFrom("audit_events")
              .select("sequence")
              .whereRef(
                "audit_events.source_id",
                "=",
                "audit_event_source_adoptions.legacy_source_id",
              ),
          ),
        ),
      ),
  );
}

export function ensureAuditEventSourceAdoptionSchema(options: OpenClawStateDatabaseOptions): void {
  const database = openOpenClawStateDatabase(options);
  if (schemaEnsured.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.exec(/* sqlite-allow-raw -- Feature-local additive schema DDL; rows use Kysely. */ `
        CREATE TABLE IF NOT EXISTS audit_event_source_adoptions (
          legacy_source_id TEXT NOT NULL PRIMARY KEY,
          adopted_source_id TEXT NOT NULL
        ) STRICT
      `);
      pruneOrphanedSourceAdoptions(db);
    },
    options,
    { operationLabel: "audit-event-source-adoptions.schema.ensure" },
  );
  schemaEnsured.add(database.db);
}

export function pruneAuditEventSourceAdoptions(db: DatabaseSync): void {
  if (!schemaEnsured.has(db)) {
    if (!tableExists(db, "audit_event_source_adoptions")) {
      return;
    }
    schemaEnsured.add(db);
  }
  pruneOrphanedSourceAdoptions(db);
}

export function adoptsEquivalentLegacyAuditEvent(
  db: DatabaseSync,
  input: AuditEventInput,
): boolean {
  if (input.kind === "message") {
    return false;
  }
  const legacySourceId = input.legacySourceId;
  if (!legacySourceId || legacySourceId === input.sourceId) {
    return false;
  }
  const legacy = executeSqliteQueryTakeFirstSync(
    db,
    getAuditKysely(db)
      .selectFrom("audit_events")
      .selectAll()
      .where("source_id", "=", legacySourceId)
      .limit(1),
  );
  if (!legacy) {
    return false;
  }
  const kysely = getAuditKysely(db);
  const existing = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("audit_event_source_adoptions")
      .select("adopted_source_id")
      .where("legacy_source_id", "=", legacySourceId)
      .limit(1),
  );
  if (existing) {
    return existing.adopted_source_id === input.sourceId;
  }
  const toolNameEquivalent =
    input.kind === "tool_action"
      ? legacy.tool_name === null || legacy.tool_name === (input.toolName ?? null)
      : legacy.tool_name === null;
  const equivalent =
    normalizeSqliteNumber(legacy.source_sequence) === input.sourceSequence &&
    normalizeSqliteNumber(legacy.occurred_at) === input.occurredAt &&
    legacy.kind === input.kind &&
    legacy.action === input.action &&
    legacy.status === input.status &&
    legacy.error_code === (input.errorCode ?? null) &&
    legacy.actor_type === input.actorType &&
    legacy.actor_id === input.actorId &&
    legacy.agent_id === input.agentId &&
    legacy.session_key === (input.sessionKey ?? null) &&
    legacy.session_id === (input.sessionId ?? null) &&
    legacy.run_id === input.runId &&
    legacy.tool_call_id === (input.kind === "tool_action" ? (input.toolCallId ?? null) : null) &&
    toolNameEquivalent;
  // Reserve the legacy key for the first versioned claimant even when it differs.
  // Otherwise a later generation that happens to match the old row could be dropped.
  const adopted = executeSqliteQuerySync(
    db,
    kysely
      .insertInto("audit_event_source_adoptions")
      .values({ legacy_source_id: legacySourceId, adopted_source_id: input.sourceId })
      .onConflict((conflict) => conflict.column("legacy_source_id").doNothing()),
  );
  if (Number(adopted.numAffectedRows ?? 0n) > 0) {
    return equivalent;
  }
  const raced = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("audit_event_source_adoptions")
      .select("adopted_source_id")
      .where("legacy_source_id", "=", legacySourceId)
      .limit(1),
  );
  return raced?.adopted_source_id === input.sourceId;
}
