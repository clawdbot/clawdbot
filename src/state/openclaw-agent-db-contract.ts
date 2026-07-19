import type { DatabaseSync } from "node:sqlite";
import type { SqliteWalMaintenance } from "../infra/sqlite-wal.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";

// v13 = one durable generation token per raw session transcript.
// v12 = session-owned ACP parent-stream events.
// v11 = agent-scoped runtime leases, durable delivery operations, canonical
// external conversation addresses, and bounded per-session heartbeat outcome context.
// v10 = materialized active transcript paths.
// v9 = SQLite STRICT tables.
// v8 added per-transcript session provenance. v7 added per-entry lifecycle status projection.
// v6 added session/transcript hot-path indexes.
// v5 added transcript mutation watermarks.
// The v4 session/transcript flip and main's v2 memory-identity
// change is folded in structure-gated migrations, so v2 main DBs and
// pre-merge v4 flip DBs both converge on this schema.
export const OPENCLAW_AGENT_SCHEMA_VERSION = 13;

/** Open per-agent SQLite database handle plus lifecycle maintenance. */
export type OpenClawAgentDatabase = {
  agentId: string;
  db: DatabaseSync;
  path: string;
  walMaintenance: SqliteWalMaintenance;
};

/** Options for resolving and opening one agent database. */
export type OpenClawAgentDatabaseOptions = OpenClawStateDatabaseOptions & {
  agentId: string;
};

/** Shared-state registry row describing an agent database seen by this process. */
export type OpenClawRegisteredAgentDatabase = {
  agentId: string;
  path: string;
  schemaVersion: number;
  lastSeenAt: number;
  sizeBytes: number | null;
};

export type OpenClawAgentDatabaseOwnerInspection =
  | { status: "owned"; agentId: string }
  | { status: "unowned" }
  | { status: "unreadable" };
