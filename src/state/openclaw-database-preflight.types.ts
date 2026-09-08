import type { SqliteSchemaIssue } from "../infra/sqlite-schema-contract.js";
import type { OpenClawExternalStateOwnership } from "./openclaw-state-ownership.js";

export type IncompatibleOpenClawDatabase = {
  kind: "agent" | "state";
  path: string;
  agentId?: string;
  foundVersion: number;
  supportedVersion: number;
  writerAppVersion?: string;
};

export type IndeterminateOpenClawDatabase = {
  kind: "agent" | "state";
  path: string;
  reason: string;
};

export type DeferredStateSchemaPublication = {
  kind: "state";
  path: string;
  foundVersion: number;
  contentVersion: number;
  runId?: string;
  publishAfterMs?: number | null;
  message: string;
};

export type OpenClawDatabaseSchemaPreflight = {
  incompatible: IncompatibleOpenClawDatabase[];
  indeterminate: IndeterminateOpenClawDatabase[];
  pendingMigrations?: Omit<IncompatibleOpenClawDatabase, "writerAppVersion">[];
  deferredSchemaPublications?: DeferredStateSchemaPublication[];
};

export type OpenClawStateSchemaPreflightResult = {
  databasePath: string;
  foundVersion: number | null;
  contentVersion?: number;
  deferredPublication?: DeferredStateSchemaPublication;
  issues: SqliteSchemaIssue[];
  ownership: OpenClawExternalStateOwnership | null;
  reason?: string;
  requiresWrite: boolean;
  schema: "openclaw.state-schema-preflight.v1";
  status: "exact" | "startup-repairable" | "migration-required" | "incompatible" | "indeterminate";
  targetVersion: number;
};

export type OpenClawAgentSchemaPreflightResult = Omit<
  OpenClawStateSchemaPreflightResult,
  "schema" | "ownership" | "status"
> & {
  schema: "openclaw.agent-schema-preflight.v1";
  agentId: string;
  status: "exact" | "incompatible" | "indeterminate";
};
