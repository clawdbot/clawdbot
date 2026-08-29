// Placement-scoped standing grants for dangerous plugin-owned node launches.
// The parent operator approval remains the sole authorization owner; every use
// revalidates the exact placement before the transport handoff.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { find as findWorkerSessionPlacement } from "./worker-environments/placement-row-codec.js";

const PLACEMENT_GRANT_TABLE = "operator_approval_placement_grants";
const PLACEMENT_GRANT_TTL_MS = 30 * 24 * 60 * 60_000;

// Mirrors the canonical declaration in openclaw-state-schema.sql. This is a
// first-use additive table, so older readers remain safe without a version bump.
const PLACEMENT_GRANT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS operator_approval_placement_grants (
  grant_id TEXT NOT NULL PRIMARY KEY CHECK (length(grant_id) > 0),
  minted_by_approval_id TEXT NOT NULL
    REFERENCES operator_approvals(approval_id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL CHECK (length(plugin_id) > 0),
  command TEXT NOT NULL CHECK (length(command) > 0),
  approval_scope TEXT NOT NULL CHECK (length(approval_scope) > 0),
  agent_id TEXT NOT NULL CHECK (length(agent_id) > 0),
  session_key TEXT NOT NULL CHECK (length(session_key) > 0),
  session_id TEXT NOT NULL CHECK (length(session_id) > 0),
  node_id TEXT NOT NULL CHECK (length(node_id) > 0),
  pairing_generation TEXT NOT NULL CHECK (length(pairing_generation) > 0),
  environment_id TEXT NOT NULL CHECK (length(environment_id) > 0),
  owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 1),
  placement_generation INTEGER NOT NULL CHECK (placement_generation >= 0),
  cwd TEXT NOT NULL CHECK (length(cwd) > 0),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= created_at_ms),
  revoked_at_ms INTEGER,
  revoked_by TEXT,
  last_used_at_ms INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX IF NOT EXISTS idx_operator_approval_placement_grants_binding
  ON operator_approval_placement_grants(
    plugin_id,
    command,
    approval_scope,
    agent_id,
    session_id,
    created_at_ms DESC
  );
`;

type PlacementGrantDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "operator_approval_placement_grants"
  | "operator_approvals"
  | "worker_environments"
  | "worker_session_placements"
>;

export type PlacementStandingGrantMintSpec = NonNullable<
  PluginApprovalRequestPayload["placementGrant"]
>;

type PlacementStandingGrantRecord = PlacementStandingGrantMintSpec & {
  grantId: string;
  mintedByApprovalId: string;
  createdAtMs: number;
  expiresAtMs: number;
  lastUsedAtMs: number | null;
  useCount: number;
};

type ConsumePlacementStandingGrantResult =
  | { outcome: "consumed"; grant: PlacementStandingGrantRecord }
  | {
      outcome:
        | "no-grant"
        | "revoked"
        | "expired"
        | "gateway-restarted"
        | "approval-missing"
        | "approval-not-allow-always"
        | "placement-missing"
        | "placement-changed"
        | "node-changed"
        | "pairing-changed";
    };

type PlacementGrantResolutionInput = Pick<
  PlacementStandingGrantMintSpec,
  | "pluginId"
  | "command"
  | "approvalScope"
  | "agentId"
  | "sessionKey"
  | "nodeId"
  | "pairingGeneration"
>;

export type PlacementStandingGrantRuntime = {
  resolveBinding: (input: PlacementGrantResolutionInput) => PlacementStandingGrantMintSpec | null;
  validate: (binding: PlacementStandingGrantMintSpec) => ConsumePlacementStandingGrantResult;
  consume: (binding: PlacementStandingGrantMintSpec) => ConsumePlacementStandingGrantResult;
};

function ensurePlacementGrantSchema(db: DatabaseSync): void {
  // sqlite-allow-raw -- first-use additive schema DDL; grant rows use Kysely.
  db.exec(PLACEMENT_GRANT_SCHEMA_SQL);
}

function hasExactAttachedSession(value: string, sessionId: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length === 1 && parsed[0] === sessionId;
  } catch {
    return false;
  }
}

function isPlacementBindingCurrent(
  database: OpenClawStateDatabase,
  binding: PlacementStandingGrantMintSpec,
): boolean {
  const placement = findWorkerSessionPlacement(database.db, binding.sessionId);
  if (
    placement?.state !== "active" ||
    placement.executionMode !== "remote-exec" ||
    placement.agentId !== binding.agentId ||
    placement.sessionKey !== binding.sessionKey ||
    placement.environmentId !== binding.environmentId ||
    placement.activeOwnerEpoch !== binding.ownerEpoch ||
    placement.generation !== binding.placementGeneration ||
    placement.remoteWorkspaceDir !== binding.cwd
  ) {
    return false;
  }
  const stateDb = getNodeSqliteKysely<PlacementGrantDatabase>(database.db);
  const environment = executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb
      .selectFrom("worker_environments")
      .select(["state", "node_device_id", "owner_epoch", "attached_session_ids_json"])
      .where("environment_id", "=", binding.environmentId),
  );
  return (
    environment?.state === "attached" &&
    environment.node_device_id === binding.nodeId &&
    environment.owner_epoch === binding.ownerEpoch &&
    hasExactAttachedSession(environment.attached_session_ids_json, binding.sessionId)
  );
}

/** Resolves the exact active node-backed placement from Gateway-owned rows. */
function resolvePlacementStandingGrantBinding(
  input: PlacementGrantResolutionInput & { databaseOptions?: OpenClawStateDatabaseOptions },
): PlacementStandingGrantMintSpec | null {
  if (
    !input.pluginId.trim() ||
    !input.command.trim() ||
    !input.approvalScope.trim() ||
    !input.agentId.trim() ||
    !input.sessionKey.trim() ||
    !input.nodeId.trim() ||
    !input.pairingGeneration.trim()
  ) {
    return null;
  }
  return runOpenClawStateWriteTransaction((database) => {
    const stateDb = getNodeSqliteKysely<PlacementGrantDatabase>(database.db);
    const candidates = executeSqliteQuerySync(
      database.db,
      stateDb
        .selectFrom("worker_session_placements")
        .select("session_id")
        .where("agent_id", "=", input.agentId)
        .where("session_key", "=", input.sessionKey)
        .where("state", "=", "active")
        .where("execution_mode", "=", "remote-exec")
        .limit(2),
    ).rows;
    if (candidates.length !== 1) {
      return null;
    }
    const placement = findWorkerSessionPlacement(database.db, candidates[0]!.session_id);
    if (
      placement?.state !== "active" ||
      placement.executionMode !== "remote-exec" ||
      !placement.environmentId ||
      !placement.activeOwnerEpoch ||
      !placement.remoteWorkspaceDir
    ) {
      return null;
    }
    const binding: PlacementStandingGrantMintSpec = {
      pluginId: input.pluginId,
      command: input.command,
      approvalScope: input.approvalScope,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      sessionId: placement.sessionId,
      nodeId: input.nodeId,
      pairingGeneration: input.pairingGeneration,
      environmentId: placement.environmentId,
      ownerEpoch: placement.activeOwnerEpoch,
      placementGeneration: placement.generation,
      cwd: placement.remoteWorkspaceDir,
    };
    return isPlacementBindingCurrent(database, binding) ? binding : null;
  }, input.databaseOptions);
}

/** Mints in the same transaction that resolves the parent approval. */
export function mintPlacementStandingGrantLocked(
  database: OpenClawStateDatabase,
  params: PlacementStandingGrantMintSpec & {
    approvalId: string;
    nowMs: number;
    expiresAtMs: number | null;
  },
): boolean {
  if (!isPlacementBindingCurrent(database, params)) {
    return false;
  }
  const maxExpiresAtMs = params.nowMs + PLACEMENT_GRANT_TTL_MS;
  const expiresAtMs = Math.min(params.expiresAtMs ?? maxExpiresAtMs, maxExpiresAtMs);
  if (expiresAtMs <= params.nowMs) {
    return false;
  }
  ensurePlacementGrantSchema(database.db);
  const stateDb = getNodeSqliteKysely<PlacementGrantDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    stateDb.deleteFrom(PLACEMENT_GRANT_TABLE).where("expires_at_ms", "<=", params.nowMs),
  );
  executeSqliteQuerySync(
    database.db,
    stateDb
      .deleteFrom(PLACEMENT_GRANT_TABLE)
      .where("plugin_id", "=", params.pluginId)
      .where("command", "=", params.command)
      .where("approval_scope", "=", params.approvalScope)
      .where("agent_id", "=", params.agentId)
      .where("session_id", "=", params.sessionId),
  );
  executeSqliteQuerySync(
    database.db,
    stateDb.insertInto(PLACEMENT_GRANT_TABLE).values({
      grant_id: randomUUID(),
      minted_by_approval_id: params.approvalId,
      plugin_id: params.pluginId,
      command: params.command,
      approval_scope: params.approvalScope,
      agent_id: params.agentId,
      session_key: params.sessionKey,
      session_id: params.sessionId,
      node_id: params.nodeId,
      pairing_generation: params.pairingGeneration,
      environment_id: params.environmentId,
      owner_epoch: params.ownerEpoch,
      placement_generation: params.placementGeneration,
      cwd: params.cwd,
      created_at_ms: params.nowMs,
      expires_at_ms: expiresAtMs,
      revoked_at_ms: null,
      revoked_by: null,
      last_used_at_ms: null,
      use_count: 0,
    }),
  );
  return true;
}

function validatePlacementStandingGrant(
  params: PlacementStandingGrantMintSpec & {
    runtimeEpoch: string;
    nowMs?: number;
    databaseOptions?: OpenClawStateDatabaseOptions;
  },
): ConsumePlacementStandingGrantResult {
  return lookupPlacementStandingGrant(params, false);
}

function consumePlacementStandingGrant(
  params: PlacementStandingGrantMintSpec & {
    runtimeEpoch: string;
    nowMs?: number;
    databaseOptions?: OpenClawStateDatabaseOptions;
  },
): ConsumePlacementStandingGrantResult {
  return lookupPlacementStandingGrant(params, true);
}

function lookupPlacementStandingGrant(
  params: PlacementStandingGrantMintSpec & {
    runtimeEpoch: string;
    nowMs?: number;
    databaseOptions?: OpenClawStateDatabaseOptions;
  },
  recordUse: boolean,
): ConsumePlacementStandingGrantResult {
  return runOpenClawStateWriteTransaction((database) => {
    if (!tableExists(database.db, PLACEMENT_GRANT_TABLE)) {
      return { outcome: "no-grant" };
    }
    const nowMs = params.nowMs ?? Date.now();
    const stateDb = getNodeSqliteKysely<PlacementGrantDatabase>(database.db);
    const grant = executeSqliteQueryTakeFirstSync(
      database.db,
      stateDb
        .selectFrom(PLACEMENT_GRANT_TABLE)
        .selectAll()
        .where("plugin_id", "=", params.pluginId)
        .where("command", "=", params.command)
        .where("approval_scope", "=", params.approvalScope)
        .where("agent_id", "=", params.agentId)
        .where("session_id", "=", params.sessionId)
        .orderBy("created_at_ms", "desc")
        .orderBy("grant_id", "desc")
        .limit(1),
    );
    if (!grant) {
      return { outcome: "no-grant" };
    }
    if (grant.revoked_at_ms !== null) {
      return { outcome: "revoked" };
    }
    if (grant.expires_at_ms <= nowMs) {
      return { outcome: "expired" };
    }
    if (grant.node_id !== params.nodeId) {
      return { outcome: "node-changed" };
    }
    if (grant.pairing_generation !== params.pairingGeneration) {
      return { outcome: "pairing-changed" };
    }
    const bindingMatches =
      grant.session_key === params.sessionKey &&
      grant.environment_id === params.environmentId &&
      grant.owner_epoch === params.ownerEpoch &&
      grant.placement_generation === params.placementGeneration &&
      grant.cwd === params.cwd;
    if (!bindingMatches || !isPlacementBindingCurrent(database, params)) {
      return findWorkerSessionPlacement(database.db, params.sessionId)
        ? { outcome: "placement-changed" }
        : { outcome: "placement-missing" };
    }
    const approval = executeSqliteQueryTakeFirstSync(
      database.db,
      stateDb
        .selectFrom("operator_approvals")
        .select(["status", "decision", "runtime_epoch"])
        .where("approval_id", "=", grant.minted_by_approval_id),
    );
    if (!approval) {
      return { outcome: "approval-missing" };
    }
    if (approval.runtime_epoch !== params.runtimeEpoch) {
      return { outcome: "gateway-restarted" };
    }
    if (approval.status !== "allowed" || approval.decision !== "allow-always") {
      return { outcome: "approval-not-allow-always" };
    }
    const record: PlacementStandingGrantRecord = {
      pluginId: grant.plugin_id,
      command: grant.command,
      approvalScope: grant.approval_scope,
      agentId: grant.agent_id,
      sessionKey: grant.session_key,
      sessionId: grant.session_id,
      nodeId: grant.node_id,
      pairingGeneration: grant.pairing_generation,
      environmentId: grant.environment_id,
      ownerEpoch: grant.owner_epoch,
      placementGeneration: grant.placement_generation,
      cwd: grant.cwd,
      grantId: grant.grant_id,
      mintedByApprovalId: grant.minted_by_approval_id,
      createdAtMs: grant.created_at_ms,
      expiresAtMs: grant.expires_at_ms,
      lastUsedAtMs: grant.last_used_at_ms,
      useCount: grant.use_count,
    };
    if (!recordUse) {
      return { outcome: "consumed", grant: record };
    }
    const nextUseCount = grant.use_count + 1;
    const updated = executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable(PLACEMENT_GRANT_TABLE)
        .set({ last_used_at_ms: nowMs, use_count: nextUseCount })
        .where("grant_id", "=", grant.grant_id)
        .where("revoked_at_ms", "is", null)
        .where("expires_at_ms", ">", nowMs),
    );
    return updated.numAffectedRows === 1n
      ? {
          outcome: "consumed",
          grant: { ...record, lastUsedAtMs: nowMs, useCount: nextUseCount },
        }
      : { outcome: "no-grant" };
  }, params.databaseOptions);
}

export function createPlacementStandingGrantRuntime(params: {
  runtimeEpoch: string;
  databaseOptions?: OpenClawStateDatabaseOptions;
  now?: () => number;
}): PlacementStandingGrantRuntime {
  const now = params.now ?? Date.now;
  return {
    resolveBinding: (input) =>
      resolvePlacementStandingGrantBinding({ ...input, databaseOptions: params.databaseOptions }),
    validate: (binding) =>
      validatePlacementStandingGrant({
        ...binding,
        runtimeEpoch: params.runtimeEpoch,
        nowMs: now(),
        databaseOptions: params.databaseOptions,
      }),
    consume: (binding) =>
      consumePlacementStandingGrant({
        ...binding,
        runtimeEpoch: params.runtimeEpoch,
        nowMs: now(),
        databaseOptions: params.databaseOptions,
      }),
  };
}
