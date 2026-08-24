// Caches the last dry-run Claw plan per agent so `--consent-latest` can bind
// consent without the operator re-pasting the integrity hash. Consent still
// fails closed: apply paths compare the cached integrity against the freshly
// rebuilt plan, so a stale cache only ever produces a plan_integrity_mismatch.
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";

export type ClawPlanConsentKind = "add" | "update" | "remove";

export type StoredClawPlanConsent = {
  agentId: string;
  planKind: ClawPlanConsentKind;
  planIntegrity: string;
  createdAtMs: number;
};

type ClawPlanConsentsDatabase = Pick<OpenClawStateKyselyDatabase, "claw_plan_consents">;

const ensuredDatabases = new WeakSet<DatabaseSync>();
const CLAW_PLAN_CONSENTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS claw_plan_consents (
  agent_id TEXT PRIMARY KEY,
  plan_kind TEXT NOT NULL CHECK (plan_kind IN ('add', 'update', 'remove')),
  plan_integrity TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;
`;

function ensureClawPlanConsentSchema(options: OpenClawStateDatabaseOptions = {}): void {
  const database = openOpenClawStateDatabase(options);
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      // sqlite-allow-raw -- feature-local additive schema DDL; cache rows use Kysely.
      db.exec(CLAW_PLAN_CONSENTS_SCHEMA_SQL);
    },
    options,
    { operationLabel: "claw-plan-consents.schema.ensure" },
  );
  ensuredDatabases.add(database.db);
}

export function storeClawPlanConsent(
  params: { agentId: string; planKind: ClawPlanConsentKind; planIntegrity: string },
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): void {
  ensureClawPlanConsentSchema(options);
  const createdAtMs = options.nowMs ?? Date.now();
  runOpenClawStateWriteTransaction(
    ({ db: sqlite }) => {
      const db = getNodeSqliteKysely<ClawPlanConsentsDatabase>(sqlite);
      executeSqliteQuerySync(
        sqlite,
        db
          .insertInto("claw_plan_consents")
          .values({
            agent_id: params.agentId,
            plan_kind: params.planKind,
            plan_integrity: params.planIntegrity,
            created_at_ms: createdAtMs,
          })
          .onConflict((conflict) =>
            conflict.column("agent_id").doUpdateSet({
              plan_kind: params.planKind,
              plan_integrity: params.planIntegrity,
              created_at_ms: createdAtMs,
            }),
          ),
      );
    },
    options,
    { operationLabel: "claw-plan-consents.store" },
  );
}

export function readClawPlanConsent(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): StoredClawPlanConsent | undefined {
  ensureClawPlanConsentSchema(options);
  const database = openOpenClawStateDatabase(options);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getNodeSqliteKysely<ClawPlanConsentsDatabase>(database.db)
      .selectFrom("claw_plan_consents")
      .selectAll()
      .where("agent_id", "=", agentId),
  );
  if (!row) {
    return undefined;
  }
  return {
    agentId: row.agent_id,
    // SAFETY: plan_kind is constrained by the table CHECK to the three kinds.
    planKind: row.plan_kind as ClawPlanConsentKind,
    planIntegrity: row.plan_integrity,
    createdAtMs: row.created_at_ms,
  };
}
