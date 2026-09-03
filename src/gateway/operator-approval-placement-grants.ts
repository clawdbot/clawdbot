// Placement-scoped standing grants for dangerous plugin-owned node launches.
// Grants live only for this Gateway process; the durable parent approval and
// current placement remain the authorization owners at every use.
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { find as findWorkerSessionPlacement } from "./worker-environments/placement-row-codec.js";

const PLACEMENT_GRANT_TTL_MS = 30 * 24 * 60 * 60_000;

type PlacementGrantDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "operator_approvals" | "worker_environments" | "worker_session_placements"
>;

export type PlacementStandingGrantMintSpec = NonNullable<
  PluginApprovalRequestPayload["placementGrant"]
>;

type PlacementStandingGrantRecord = PlacementStandingGrantMintSpec & {
  mintedByApprovalId: string;
  expiresAtMs: number;
};

type ConsumePlacementStandingGrantResult =
  | { outcome: "consumed"; grant: PlacementStandingGrantRecord }
  | {
      outcome:
        | "no-grant"
        | "expired"
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
  retain: (
    grant: PlacementStandingGrantMintSpec & {
      approvalId: string;
      nowMs: number;
      expiresAtMs: number | null;
    },
  ) => boolean;
  validate: (binding: PlacementStandingGrantMintSpec) => ConsumePlacementStandingGrantResult;
  consume: (binding: PlacementStandingGrantMintSpec) => ConsumePlacementStandingGrantResult;
};

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

function placementGrantKey(binding: PlacementStandingGrantMintSpec): string {
  return JSON.stringify([
    binding.pluginId,
    binding.command,
    binding.approvalScope,
    binding.agentId,
    binding.sessionId,
  ]);
}

function resolveRetainedGrant(params: {
  grants: Map<string, PlacementStandingGrantRecord>;
  binding: PlacementStandingGrantMintSpec;
  runtimeEpoch: string;
  nowMs: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): ConsumePlacementStandingGrantResult {
  const key = placementGrantKey(params.binding);
  const grant = params.grants.get(key);
  if (!grant) {
    return { outcome: "no-grant" };
  }
  if (grant.expiresAtMs <= params.nowMs) {
    params.grants.delete(key);
    return { outcome: "expired" };
  }
  if (grant.nodeId !== params.binding.nodeId) {
    params.grants.delete(key);
    return { outcome: "node-changed" };
  }
  if (grant.pairingGeneration !== params.binding.pairingGeneration) {
    params.grants.delete(key);
    return { outcome: "pairing-changed" };
  }
  return runOpenClawStateWriteTransaction((database) => {
    const bindingMatches =
      grant.sessionKey === params.binding.sessionKey &&
      grant.environmentId === params.binding.environmentId &&
      grant.ownerEpoch === params.binding.ownerEpoch &&
      grant.placementGeneration === params.binding.placementGeneration &&
      grant.cwd === params.binding.cwd;
    if (!bindingMatches || !isPlacementBindingCurrent(database, params.binding)) {
      params.grants.delete(key);
      return findWorkerSessionPlacement(database.db, params.binding.sessionId)
        ? { outcome: "placement-changed" }
        : { outcome: "placement-missing" };
    }
    const stateDb = getNodeSqliteKysely<PlacementGrantDatabase>(database.db);
    const approval = executeSqliteQueryTakeFirstSync(
      database.db,
      stateDb
        .selectFrom("operator_approvals")
        .select(["status", "decision", "runtime_epoch"])
        .where("approval_id", "=", grant.mintedByApprovalId),
    );
    if (!approval) {
      params.grants.delete(key);
      return { outcome: "approval-missing" };
    }
    if (
      approval.runtime_epoch !== params.runtimeEpoch ||
      approval.status !== "allowed" ||
      approval.decision !== "allow-always"
    ) {
      params.grants.delete(key);
      return { outcome: "approval-not-allow-always" };
    }
    return { outcome: "consumed", grant };
  }, params.databaseOptions);
}

export function createPlacementStandingGrantRuntime(params: {
  runtimeEpoch: string;
  databaseOptions?: OpenClawStateDatabaseOptions;
  now?: () => number;
}): PlacementStandingGrantRuntime {
  const grants = new Map<string, PlacementStandingGrantRecord>();
  const now = params.now ?? Date.now;
  return {
    resolveBinding: (input) =>
      resolvePlacementStandingGrantBinding({ ...input, databaseOptions: params.databaseOptions }),
    retain: (grant) => {
      const maxExpiresAtMs = grant.nowMs + PLACEMENT_GRANT_TTL_MS;
      const expiresAtMs = Math.min(grant.expiresAtMs ?? maxExpiresAtMs, maxExpiresAtMs);
      if (expiresAtMs <= grant.nowMs) {
        return false;
      }
      try {
        const retained = runOpenClawStateWriteTransaction((database) => {
          if (!isPlacementBindingCurrent(database, grant)) {
            return null;
          }
          const stateDb = getNodeSqliteKysely<PlacementGrantDatabase>(database.db);
          const approval = executeSqliteQueryTakeFirstSync(
            database.db,
            stateDb
              .selectFrom("operator_approvals")
              .select(["status", "decision", "runtime_epoch"])
              .where("approval_id", "=", grant.approvalId),
          );
          if (
            approval?.runtime_epoch !== params.runtimeEpoch ||
            approval.status !== "allowed" ||
            approval.decision !== "allow-always"
          ) {
            return null;
          }
          return {
            pluginId: grant.pluginId,
            command: grant.command,
            approvalScope: grant.approvalScope,
            agentId: grant.agentId,
            sessionKey: grant.sessionKey,
            sessionId: grant.sessionId,
            nodeId: grant.nodeId,
            pairingGeneration: grant.pairingGeneration,
            environmentId: grant.environmentId,
            ownerEpoch: grant.ownerEpoch,
            placementGeneration: grant.placementGeneration,
            cwd: grant.cwd,
            mintedByApprovalId: grant.approvalId,
            expiresAtMs,
          } satisfies PlacementStandingGrantRecord;
        }, params.databaseOptions);
        if (!retained) {
          return false;
        }
        grants.set(placementGrantKey(retained), retained);
        return true;
      } catch {
        return false;
      }
    },
    validate: (binding) =>
      resolveRetainedGrant({
        grants,
        binding,
        runtimeEpoch: params.runtimeEpoch,
        nowMs: now(),
        databaseOptions: params.databaseOptions,
      }),
    consume: (binding) =>
      resolveRetainedGrant({
        grants,
        binding,
        runtimeEpoch: params.runtimeEpoch,
        nowMs: now(),
        databaseOptions: params.databaseOptions,
      }),
  };
}
