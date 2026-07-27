// Persists the root ownership record for one Claw-created agent and workspace.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { stableStringify } from "../agents/stable-stringify.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { ClawAddPlan, ClawPackage, ResolvedClawPackage } from "./types.js";

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

type InstallRow = {
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
  agent_id: string;
  workspace: string;
  agent_config_digest: string;
  agent_owned_paths_json: string;
  status: ClawInstallStatus;
  added_at_ms: number | bigint;
  updated_at_ms: number | bigint;
};

function rowToInstall(row: InstallRow): PersistedClawInstall {
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

export function readClawInstallRecords(
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawInstall[] {
  const database = openOpenClawStateDatabase(options);
  // sqlite-allow-raw: read-only Claw install inventory ordered by stable agent id.
  const rows =
    database.db /* sqlite-allow-raw: read-only Claw install inventory ordered by stable agent id. */
      .prepare(
        `SELECT schema_version, source_kind, claw_name, claw_version, package_root,
              manifest_path, integrity_kind, integrity, source_byte_length,
              manifest_schema_version, plan_integrity, agent_id, workspace,
              agent_config_digest, agent_owned_paths_json, status, added_at_ms,
              updated_at_ms
         FROM claw_installs
        ORDER BY agent_id`,
      )
      .all() as InstallRow[];
  return rows.map(rowToInstall);
}

export const CLAW_PACKAGE_REF_SCHEMA_VERSION = "openclaw.clawPackageRef.v1" as const;
type ClawPackageRefStatus = "pending" | "complete" | "failed" | "rolled_back";
type ClawPackageRelationship = "managed" | "referenced";
type ClawPackageOrigin = "claw-introduced" | "pre-existing";

export type PersistedClawPackageRef = {
  schemaVersion: typeof CLAW_PACKAGE_REF_SCHEMA_VERSION;
  agentId: string;
  clawName: string;
  kind: ClawPackage["kind"];
  source: ClawPackage["source"];
  ref: string;
  version: string;
  integrity: string;
  status: ClawPackageRefStatus;
  relationship: ClawPackageRelationship;
  origin: ClawPackageOrigin;
  independentOwner: boolean;
  installedAtMs: number;
  updatedAtMs: number;
};

type PackageRefRow = {
  schema_version: string;
  agent_id: string;
  claw_name: string;
  package_kind: ClawPackage["kind"];
  package_source: ClawPackage["source"];
  package_ref: string;
  package_version: string;
  package_integrity: string;
  package_status: ClawPackageRefStatus;
  relationship: ClawPackageRelationship;
  origin: ClawPackageOrigin;
  independent_owner: number | bigint;
  installed_at_ms: number | bigint;
  updated_at_ms: number | bigint;
};

export function updateClawInstallRecord(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & {
    nowMs?: number;
    expectedClaw?: { version: string; integrity: string };
    status?: ClawInstallStatus;
  } = {},
): PersistedClawInstall {
  const current = readClawInstallRecord(plan.agent.finalId, options);
  if (!current) {
    throw new Error(
      `No Claw install record exists for agent ${JSON.stringify(plan.agent.finalId)}.`,
    );
  }
  const updatedAtMs = options.nowMs ?? Date.now();
  const status = options.status ?? "complete";
  const agentConfigDigest = digestAgentConfig(plan);
  const ownedAgentPaths = plan.actions
    .filter((action) => action.kind === "agent")
    .map((action) => action.target);
  runOpenClawStateWriteTransaction(({ db }) => {
    const result = db /* sqlite-allow-raw: Claw install provenance compare-and-swap write. */
      .prepare(
        `UPDATE claw_installs
            SET source_kind = @source_kind,
                claw_name = @claw_name,
                claw_version = @claw_version,
                package_root = @package_root,
                manifest_path = @manifest_path,
                integrity_kind = @integrity_kind,
                integrity = @integrity,
                source_byte_length = @source_byte_length,
                manifest_schema_version = @manifest_schema_version,
                plan_integrity = @plan_integrity,
                workspace = @workspace,
                agent_config_digest = @agent_config_digest,
                agent_owned_paths_json = @agent_owned_paths_json,
                status = @status,
                updated_at_ms = @updated_at_ms
          WHERE agent_id = @agent_id
            AND claw_version = @expected_claw_version
            AND integrity = @expected_integrity`,
      )
      .run({
        agent_id: plan.agent.finalId,
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
        agent_owned_paths_json: JSON.stringify(ownedAgentPaths),
        status,
        updated_at_ms: updatedAtMs,
        expected_claw_version: options.expectedClaw?.version ?? current.claw.version,
        expected_integrity: options.expectedClaw?.integrity ?? current.claw.integrity,
      });
    if (Number(result.changes) !== 1) {
      throw new Error(
        `Claw install record changed for agent ${JSON.stringify(plan.agent.finalId)}.`,
      );
    }
  }, options);
  return {
    schemaVersion: CLAW_INSTALL_RECORD_SCHEMA_VERSION,
    claw: plan.claw,
    manifestSchemaVersion: plan.manifestSchemaVersion,
    planIntegrity: plan.planIntegrity,
    agentId: plan.agent.finalId,
    workspace: plan.agent.workspace,
    agentConfigDigest,
    agentOwnedPaths: ownedAgentPaths,
    status,
    addedAtMs: current.addedAtMs,
    updatedAtMs,
  };
}

function rowToPackageRef(row: PackageRefRow): PersistedClawPackageRef {
  return {
    schemaVersion: CLAW_PACKAGE_REF_SCHEMA_VERSION,
    agentId: row.agent_id,
    clawName: row.claw_name,
    kind: row.package_kind,
    source: row.package_source,
    ref: row.package_ref,
    version: row.package_version,
    integrity: row.package_integrity,
    status: row.package_status,
    relationship: row.relationship,
    origin: row.origin,
    independentOwner: Number(row.independent_owner) === 1,
    installedAtMs: Number(row.installed_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export function persistClawPackageRef(
  plan: ClawAddPlan,
  pkg: ResolvedClawPackage,
  options: OpenClawStateDatabaseOptions & {
    nowMs?: number;
    status?: ClawPackageRefStatus;
    relationship?: ClawPackageRelationship;
    origin?: ClawPackageOrigin;
    independentOwner?: boolean;
  } = {},
): PersistedClawPackageRef {
  const nowMs = options.nowMs ?? Date.now();
  let record: PersistedClawPackageRef = {
    schemaVersion: CLAW_PACKAGE_REF_SCHEMA_VERSION,
    agentId: plan.agent.finalId,
    clawName: plan.claw.name,
    kind: pkg.kind,
    source: pkg.source,
    ref: pkg.ref,
    version: pkg.version,
    integrity: pkg.integrity,
    status: options.status ?? "complete",
    relationship: options.relationship ?? (pkg.kind === "skill" ? "managed" : "referenced"),
    origin: options.origin ?? "claw-introduced",
    independentOwner: options.independentOwner ?? false,
    installedAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  runOpenClawStateWriteTransaction(({ db }) => {
    const existing = db /* sqlite-allow-raw: exact owned package-ref replay lookup. */
      .prepare(
        `SELECT schema_version, agent_id, claw_name, package_kind, package_source,
                package_ref, package_version, package_integrity, package_status, relationship, origin,
                independent_owner,
                installed_at_ms, updated_at_ms
           FROM claw_package_refs
          WHERE agent_id = @agent_id
            AND package_kind = @package_kind
            AND package_source = @package_source
            AND package_ref = @package_ref
            AND package_version = @package_version`,
      )
      .get({
        agent_id: record.agentId,
        package_kind: record.kind,
        package_source: record.source,
        package_ref: record.ref,
        package_version: record.version,
      }) as PackageRefRow | undefined;
    if (existing) {
      const previous = rowToPackageRef(existing);
      if (previous.integrity !== record.integrity) {
        throw new Error(
          `Claw package reference ${record.kind}:${record.ref}@${record.version} changed integrity from ${previous.integrity} to ${record.integrity}.`,
        );
      }
      record = {
        ...record,
        relationship: previous.relationship,
        origin: previous.origin === "claw-introduced" ? "claw-introduced" : record.origin,
        independentOwner: previous.independentOwner || record.independentOwner,
        installedAtMs: previous.installedAtMs,
      };
      db /* sqlite-allow-raw: exact owned package-ref retry update. */
        .prepare(
          `UPDATE claw_package_refs
            SET schema_version = @schema_version,
                claw_name = @claw_name,
                package_status = @package_status,
                relationship = @relationship,
                origin = @origin,
                independent_owner = @independent_owner,
                updated_at_ms = @updated_at_ms
          WHERE agent_id = @agent_id
            AND package_kind = @package_kind
            AND package_source = @package_source
            AND package_ref = @package_ref
            AND package_version = @package_version
            AND package_integrity = @package_integrity`,
        )
        .run({
          agent_id: record.agentId,
          package_kind: record.kind,
          package_source: record.source,
          package_ref: record.ref,
          package_version: record.version,
          package_integrity: record.integrity,
          schema_version: record.schemaVersion,
          claw_name: record.clawName,
          package_status: record.status,
          relationship: record.relationship,
          origin: record.origin,
          independent_owner: record.independentOwner ? 1 : 0,
          updated_at_ms: record.updatedAtMs,
        });
      return;
    }
    // sqlite-allow-raw: this Claw prototype state-table write is scoped to one owned row.
    db /* sqlite-allow-raw: Claw package provenance upsert. */
      .prepare(
        `INSERT INTO claw_package_refs (
         agent_id, package_kind, package_source, package_ref, package_version,
         package_integrity, schema_version, claw_name, package_status, relationship, origin,
         independent_owner,
         installed_at_ms,
         updated_at_ms
       ) VALUES (
         @agent_id, @package_kind, @package_source, @package_ref, @package_version,
         @package_integrity, @schema_version, @claw_name, @package_status, @relationship, @origin,
         @independent_owner,
         @installed_at_ms,
         @updated_at_ms
       )`,
      )
      .run({
        agent_id: record.agentId,
        package_kind: record.kind,
        package_source: record.source,
        package_ref: record.ref,
        package_version: record.version,
        package_integrity: record.integrity,
        schema_version: record.schemaVersion,
        claw_name: record.clawName,
        package_status: record.status,
        relationship: record.relationship,
        origin: record.origin,
        independent_owner: record.independentOwner ? 1 : 0,
        installed_at_ms: record.installedAtMs,
        updated_at_ms: record.updatedAtMs,
      });
  }, options);
  return record;
}

export function updateClawPackageRefStatus(
  ref: PersistedClawPackageRef,
  status: ClawPackageRefStatus,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): PersistedClawPackageRef {
  const nowMs = options.nowMs ?? Date.now();
  runOpenClawStateWriteTransaction(({ db }) => {
    // sqlite-allow-raw: this Claw package reference status update is scoped to one owned row.
    db.prepare(
      `UPDATE claw_package_refs
          SET package_status = @package_status, updated_at_ms = @updated_at_ms
        WHERE agent_id = @agent_id
          AND package_kind = @package_kind
          AND package_source = @package_source
          AND package_ref = @package_ref
          AND package_version = @package_version
          AND package_integrity = @package_integrity`,
    ).run({
      agent_id: ref.agentId,
      package_kind: ref.kind,
      package_source: ref.source,
      package_ref: ref.ref,
      package_version: ref.version,
      package_integrity: ref.integrity,
      package_status: status,
      updated_at_ms: nowMs,
    });
  }, options);
  return { ...ref, status, updatedAtMs: nowMs };
}

export function readClawPackageRefs(
  options: OpenClawStateDatabaseOptions & {
    agentId?: string;
    kind?: ClawPackage["kind"];
    source?: ClawPackage["source"];
    ref?: string;
    version?: string;
    integrity?: string;
    status?: ClawPackageRefStatus;
  } = {},
): PersistedClawPackageRef[] {
  const database = openOpenClawStateDatabase(options);
  if (
    options.readOnly &&
    !database.db /* sqlite-allow-raw: read-only Claw package-ref table-existence probe. */
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claw_package_refs'")
      .get()
  ) {
    return [];
  }
  const conditions: string[] = [];
  const params: Record<string, string> = {};
  for (const [column, value] of [
    ["agent_id", options.agentId],
    ["package_kind", options.kind],
    ["package_source", options.source],
    ["package_ref", options.ref],
    ["package_version", options.version],
    ["package_integrity", options.integrity],
    ["package_status", options.status],
  ] as const) {
    if (value !== undefined) {
      conditions.push(`${column} = @${column}`);
      params[column] = value;
    }
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const rows =
    database.db /* sqlite-allow-raw: read-only Claw package reference lookup with closed column filters. */
      .prepare(
        `SELECT schema_version, agent_id, claw_name, package_kind, package_source,
              package_ref, package_version, package_integrity, package_status, relationship, origin,
              independent_owner,
              installed_at_ms,
              updated_at_ms
         FROM claw_package_refs${where}
        ORDER BY agent_id, package_kind, package_ref`,
      )
      .all(params) as PackageRefRow[];
  return rows.map(rowToPackageRef);
}
