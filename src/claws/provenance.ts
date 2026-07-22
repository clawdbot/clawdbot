// Persists the root ownership record for one Claw-created agent and workspace.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { stableStringify } from "../agents/stable-stringify.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { ClawAddPlan } from "./types.js";

const CLAW_INSTALL_RECORD_SCHEMA_VERSION = "openclaw.clawInstallRecord.v1" as const;

export type ClawInstallStatus =
  | "pending"
  | "workspace_ready"
  | "config_committed"
  | "complete"
  | "partial";

type ClawInstallRow = {
  agent_id: string;
  schema_version: string;
  source_kind: "package" | "development";
  claw_name: string;
  claw_version: string;
  package_root: string;
  manifest_path: string;
  integrity_kind: "artifact" | "development-snapshot";
  integrity: string;
  source_byte_length: number | bigint;
  manifest_schema_version: number | bigint;
  plan_integrity: string;
  workspace: string;
  agent_config_digest: string;
  agent_owned_paths_json: string;
  status: ClawInstallStatus;
  added_at_ms: number | bigint;
  updated_at_ms: number | bigint;
};

export type PersistedClawInstall = {
  schemaVersion: typeof CLAW_INSTALL_RECORD_SCHEMA_VERSION;
  claw: ClawAddPlan["claw"];
  manifestSchemaVersion: ClawAddPlan["manifestSchemaVersion"];
  planIntegrity: string;
  agentId: string;
  workspace: string;
  agentConfigDigest: string;
  agentOwnedPaths: string[];
  status: ClawInstallStatus;
  addedAtMs: number;
  updatedAtMs: number;
};

function digestAgentConfig(plan: ClawAddPlan): string {
  return `sha256:${createHash("sha256").update(stableStringify(plan.agent.config)).digest("hex")}`;
}

function agentOwnedPaths(plan: ClawAddPlan): string[] {
  return plan.actions.filter((action) => action.kind === "agent").map((action) => action.target);
}

function rowToRecord(row: ClawInstallRow): PersistedClawInstall {
  return {
    schemaVersion: CLAW_INSTALL_RECORD_SCHEMA_VERSION,
    claw: {
      kind: row.source_kind,
      name: row.claw_name,
      version: row.claw_version,
      packageRoot: row.package_root,
      manifestPath: row.manifest_path,
      integrityKind: row.integrity_kind,
      integrity: row.integrity,
      byteLength: Number(row.source_byte_length),
    },
    manifestSchemaVersion: Number(
      row.manifest_schema_version,
    ) as ClawAddPlan["manifestSchemaVersion"],
    planIntegrity: row.plan_integrity,
    agentId: row.agent_id,
    workspace: row.workspace,
    agentConfigDigest: row.agent_config_digest,
    agentOwnedPaths: JSON.parse(row.agent_owned_paths_json) as string[],
    status: row.status,
    addedAtMs: Number(row.added_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function selectClawInstallRow(db: DatabaseSync, agentId: string): ClawInstallRow | undefined {
  return db /* sqlite-allow-raw: this Claw prototype state-table read is scoped to one owned row. */
    .prepare(
      `SELECT agent_id, schema_version, source_kind, claw_name, claw_version,
              package_root, manifest_path, integrity_kind, integrity, source_byte_length,
              manifest_schema_version, plan_integrity, workspace, agent_config_digest,
              agent_owned_paths_json, status, added_at_ms, updated_at_ms
         FROM claw_installs
        WHERE agent_id = ?`,
    )
    .get(agentId) as ClawInstallRow | undefined;
}

function getClawInstallRow(
  agentId: string,
  options: OpenClawStateDatabaseOptions,
): ClawInstallRow | undefined {
  return selectClawInstallRow(openOpenClawStateDatabase(options).db, agentId);
}

export function readClawInstallRecord(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawInstall | undefined {
  const row = getClawInstallRow(agentId, options);
  return row ? rowToRecord(row) : undefined;
}

function isSameInstallAttempt(
  row: ClawInstallRow,
  plan: ClawAddPlan,
  agentConfigDigest: string,
  ownedPaths: string[],
): boolean {
  return (
    row.schema_version === CLAW_INSTALL_RECORD_SCHEMA_VERSION &&
    row.source_kind === plan.claw.kind &&
    row.claw_name === plan.claw.name &&
    row.claw_version === plan.claw.version &&
    row.package_root === plan.claw.packageRoot &&
    row.manifest_path === plan.claw.manifestPath &&
    row.integrity_kind === plan.claw.integrityKind &&
    row.integrity === plan.claw.integrity &&
    Number(row.source_byte_length) === plan.claw.byteLength &&
    Number(row.manifest_schema_version) === plan.manifestSchemaVersion &&
    row.plan_integrity === plan.planIntegrity &&
    row.workspace === plan.agent.workspace &&
    row.agent_config_digest === agentConfigDigest &&
    row.agent_owned_paths_json === JSON.stringify(ownedPaths)
  );
}

export function persistClawInstallRecord(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & { status?: ClawInstallStatus; nowMs?: number } = {},
): PersistedClawInstall {
  const nowMs = options.nowMs ?? Date.now();
  const status = options.status ?? "complete";
  const agentConfigDigest = digestAgentConfig(plan);
  const ownedPaths = agentOwnedPaths(plan);
  return runOpenClawStateWriteTransaction(({ db }) => {
    const existing = selectClawInstallRow(db, plan.agent.finalId);
    if (existing) {
      if (
        existing.status !== "complete" &&
        isSameInstallAttempt(existing, plan, agentConfigDigest, ownedPaths)
      ) {
        return rowToRecord(existing);
      }
      // A nonmatching partial attempt remains durable ownership evidence. A later
      // remove/doctor lifecycle must clear it; a new plan must never overwrite it.
      throw new Error(
        `Claw install record for agent ${JSON.stringify(plan.agent.finalId)} already exists.`,
      );
    }
    // sqlite-allow-raw: this Claw prototype state-table write is scoped to one owned row.
    db.prepare(
      `INSERT INTO claw_installs (
         agent_id, schema_version, source_kind, claw_name, claw_version,
         package_root, manifest_path, integrity_kind, integrity, source_byte_length,
         manifest_schema_version, plan_integrity, workspace, agent_config_digest,
         agent_owned_paths_json,
         status, added_at_ms, updated_at_ms
       ) VALUES (
         @agent_id, @schema_version, @source_kind, @claw_name, @claw_version,
         @package_root, @manifest_path, @integrity_kind, @integrity, @source_byte_length,
         @manifest_schema_version, @plan_integrity, @workspace, @agent_config_digest,
         @agent_owned_paths_json,
         @status, @added_at_ms, @updated_at_ms
       )`,
    ).run({
      agent_id: plan.agent.finalId,
      schema_version: CLAW_INSTALL_RECORD_SCHEMA_VERSION,
      source_kind: plan.claw.kind,
      claw_name: plan.claw.name,
      claw_version: plan.claw.version,
      package_root: plan.claw.packageRoot,
      manifest_path: plan.claw.manifestPath,
      integrity_kind: plan.claw.integrityKind,
      integrity: plan.claw.integrity,
      source_byte_length: plan.claw.byteLength,
      manifest_schema_version: plan.manifestSchemaVersion,
      plan_integrity: plan.planIntegrity,
      workspace: plan.agent.workspace,
      agent_config_digest: agentConfigDigest,
      agent_owned_paths_json: JSON.stringify(ownedPaths),
      status,
      added_at_ms: nowMs,
      updated_at_ms: nowMs,
    });
    return {
      schemaVersion: CLAW_INSTALL_RECORD_SCHEMA_VERSION,
      claw: plan.claw,
      manifestSchemaVersion: plan.manifestSchemaVersion,
      planIntegrity: plan.planIntegrity,
      agentId: plan.agent.finalId,
      workspace: plan.agent.workspace,
      agentConfigDigest,
      agentOwnedPaths: ownedPaths,
      status,
      addedAtMs: nowMs,
      updatedAtMs: nowMs,
    };
  }, options);
}

export function updateClawInstallRecordStatus(
  agentId: string,
  status: ClawInstallStatus,
  options: OpenClawStateDatabaseOptions & {
    nowMs?: number;
    expectedStatuses?: ClawInstallStatus[];
  } = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    const expectedStatuses = options.expectedStatuses ?? [];
    const expectedClause =
      expectedStatuses.length > 0
        ? ` AND status IN (${expectedStatuses.map(() => "?").join(", ")})`
        : "";
    const result =
      db /* sqlite-allow-raw: this Claw prototype state-table write is scoped to one owned row. */
        .prepare(
          `UPDATE claw_installs
            SET status = ?, updated_at_ms = ?
          WHERE agent_id = ?${expectedClause}`,
        )
        .run(status, options.nowMs ?? Date.now(), agentId, ...expectedStatuses);
    if (result.changes !== 1) {
      throw new Error(
        `Claw install record for agent ${JSON.stringify(agentId)} did not match the expected phase.`,
      );
    }
  }, options);
}

export function deleteClawInstallRecord(
  agentId: string,
  options: OpenClawStateDatabaseOptions & { expectedStatuses?: ClawInstallStatus[] } = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    const expectedStatuses = options.expectedStatuses ?? [];
    const expectedClause =
      expectedStatuses.length > 0
        ? ` AND status IN (${expectedStatuses.map(() => "?").join(", ")})`
        : "";
    const result =
      db /* sqlite-allow-raw: this Claw prototype state-table delete is scoped to one owned row. */
        .prepare(`DELETE FROM claw_installs WHERE agent_id = ?${expectedClause}`)
        .run(agentId, ...expectedStatuses);
    if (result.changes !== 1) {
      throw new Error(
        `Claw install record for agent ${JSON.stringify(agentId)} did not match the expected phase.`,
      );
    }
  }, options);
}
