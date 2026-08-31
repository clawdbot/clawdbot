import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";

export type AgentCreatedVia = "operator" | "agent" | "claw";

export type AgentProvenance = {
  agentId: string;
  createdVia: AgentCreatedVia;
  creatorAgentId: string | null;
  createdAtMs: number;
};

type AgentProvenanceDatabase = Pick<OpenClawStateKyselyDatabase, "agent_provenance">;
type AgentProvenanceOptions = OpenClawStateDatabaseOptions & { nowMs?: number };

const ensuredDatabases = new WeakSet<DatabaseSync>();
const AGENT_PROVENANCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_provenance (
  agent_id TEXT PRIMARY KEY,
  created_via TEXT NOT NULL CHECK (created_via IN ('operator', 'agent', 'claw')),
  creator_agent_id TEXT,
  created_at_ms INTEGER NOT NULL
) STRICT;
`;

export function ensureAgentProvenanceSchema(options: OpenClawStateDatabaseOptions = {}): void {
  const database = openOpenClawStateDatabase(options);
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      // sqlite-allow-raw -- feature-local additive schema DDL; provenance rows use Kysely.
      db.exec(AGENT_PROVENANCE_SCHEMA_SQL);
    },
    options,
    { operationLabel: "agent-provenance.schema.ensure" },
  );
  ensuredDatabases.add(database.db);
}

function fromRow(row: {
  agent_id: string;
  created_via: string;
  creator_agent_id: string | null;
  created_at_ms: number;
}): AgentProvenance {
  let createdVia: AgentCreatedVia;
  switch (row.created_via) {
    case "operator":
    case "agent":
    case "claw":
      createdVia = row.created_via;
      break;
    default:
      throw new Error(`Invalid agent provenance created_via: ${row.created_via}`);
  }
  return {
    agentId: row.agent_id,
    createdVia,
    creatorAgentId: row.creator_agent_id,
    createdAtMs: row.created_at_ms,
  };
}

export function recordAgentProvenance(
  agentId: string,
  provenance: { createdVia: AgentCreatedVia; creatorAgentId?: string },
  options: AgentProvenanceOptions = {},
): void {
  ensureAgentProvenanceSchema(options);
  const id = normalizeAgentId(agentId);
  const creatorAgentId = provenance.creatorAgentId
    ? normalizeAgentId(provenance.creatorAgentId)
    : null;
  const createdAtMs = options.nowMs ?? Date.now();
  runOpenClawStateWriteTransaction(
    ({ db: sqlite }) => {
      const db = getNodeSqliteKysely<AgentProvenanceDatabase>(sqlite);
      executeSqliteQuerySync(
        sqlite,
        db
          .insertInto("agent_provenance")
          .values({
            agent_id: id,
            created_via: provenance.createdVia,
            creator_agent_id: creatorAgentId,
            created_at_ms: createdAtMs,
          })
          .onConflict((conflict) =>
            conflict.column("agent_id").doUpdateSet({
              created_via: provenance.createdVia,
              creator_agent_id: creatorAgentId,
              created_at_ms: createdAtMs,
            }),
          ),
      );
    },
    options,
    { operationLabel: "agent-provenance.record" },
  );
}

export function readAgentProvenance(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): AgentProvenance | undefined {
  ensureAgentProvenanceSchema(options);
  const database = openOpenClawStateDatabase(options);
  const db = getNodeSqliteKysely<AgentProvenanceDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("agent_provenance").selectAll().where("agent_id", "=", normalizeAgentId(agentId)),
  );
  return row ? fromRow(row) : undefined;
}

export function listAgentProvenance(options: OpenClawStateDatabaseOptions = {}): AgentProvenance[] {
  ensureAgentProvenanceSchema(options);
  const database = openOpenClawStateDatabase(options);
  const db = getNodeSqliteKysely<AgentProvenanceDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    db.selectFrom("agent_provenance").selectAll().orderBy("agent_id", "asc"),
  ).rows.map(fromRow);
}

/** Delete one row inside the caller's authoritative state transaction. */
export function deleteAgentProvenanceForAgent(database: DatabaseSync, agentId: string): void {
  const db = getNodeSqliteKysely<AgentProvenanceDatabase>(database);
  executeSqliteQuerySync(
    database,
    db.deleteFrom("agent_provenance").where("agent_id", "=", normalizeAgentId(agentId)),
  );
}
