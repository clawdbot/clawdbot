import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type {
  DB as StateDatabase,
  WorkerSessionPlacements,
} from "../../state/openclaw-state-db.generated.js";
import {
  assertRecordShape,
  localTurnClaimForState,
  nextGeneration,
  normalizeCursor,
  normalizeEpoch,
  nullableRequired,
  required,
  unclaimedTurnForState,
  workerTurnClaimForState,
  type EmptyWorkerPlacementMetadata,
  type OwnedWorkerPlacementMetadata,
  type PersistedTurnClaim,
  type WorkerSessionPlacementIdentity,
  type WorkerSessionPlacementRecord,
  type WorkerSessionPlacementTransitionPatch,
} from "./placement-record.js";
import { parseWorkerSessionPlacementState } from "./placement-state.js";

type PlacementRow = Selectable<WorkerSessionPlacements>;
type PlacementDatabase = Pick<StateDatabase, "worker_session_placements">;

export const query = (db: DatabaseSync) => getNodeSqliteKysely<PlacementDatabase>(db);

const EMPTY_WORKER_METADATA: EmptyWorkerPlacementMetadata = {
  environmentId: null,
  activeOwnerEpoch: null,
  workspaceBaseManifestRef: null,
  remoteWorkspaceDir: null,
  workerBundleHash: null,
  lastTranscriptAckCursor: null,
  lastLiveEventAckCursor: null,
  recoveryError: null,
};

function parseTurnClaim(row: PlacementRow): PersistedTurnClaim | null {
  if (row.turn_claim_owner === null) {
    return null;
  }
  const claimId = required(row.turn_claim_id ?? "", "turn claim id");
  const runId = required(row.turn_claim_run_id ?? "", "turn claim run id");
  const generation = row.turn_claim_generation;
  if (generation === null || !Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("Worker session placement turn claim generation is invalid");
  }
  if (row.turn_claim_owner === "local") {
    if (row.turn_claim_owner_epoch !== null) {
      throw new Error("Local turn claim cannot retain a worker owner epoch");
    }
    return { owner: "local", claimId, runId, generation, ownerEpoch: null };
  }
  if (row.turn_claim_owner === "worker") {
    return {
      owner: "worker",
      claimId,
      runId,
      generation,
      ownerEpoch: normalizeEpoch(row.turn_claim_owner_epoch ?? 0, "turn claim owner epoch"),
    };
  }
  throw new Error(`Invalid worker session turn claim owner: ${row.turn_claim_owner}`);
}

type ParsedWorkerMetadata = {
  environmentId: string | null;
  activeOwnerEpoch: number | null;
  workspaceBaseManifestRef: string | null;
  remoteWorkspaceDir: string | null;
  workerBundleHash: string | null;
  lastTranscriptAckCursor: number | null;
  lastLiveEventAckCursor: number | null;
};

function ownedWorkerMetadata(
  parsed: ParsedWorkerMetadata,
  state: "active" | "draining" | "reconciling" | "reclaimed",
): OwnedWorkerPlacementMetadata {
  if (
    parsed.environmentId === null ||
    parsed.activeOwnerEpoch === null ||
    parsed.workspaceBaseManifestRef === null ||
    parsed.remoteWorkspaceDir === null ||
    parsed.workerBundleHash === null
  ) {
    throw new Error(`Worker session placement ${state} requires complete worker ownership`);
  }
  return {
    environmentId: parsed.environmentId,
    activeOwnerEpoch: parsed.activeOwnerEpoch,
    workspaceBaseManifestRef: parsed.workspaceBaseManifestRef,
    remoteWorkspaceDir: parsed.remoteWorkspaceDir,
    workerBundleHash: parsed.workerBundleHash,
    lastTranscriptAckCursor: parsed.lastTranscriptAckCursor,
    lastLiveEventAckCursor: parsed.lastLiveEventAckCursor,
    recoveryError: null,
  };
}

export function fromRow(row: PlacementRow): WorkerSessionPlacementRecord {
  const state = parseWorkerSessionPlacementState(row.state);
  const parsed: ParsedWorkerMetadata = {
    environmentId:
      row.environment_id === null ? null : required(row.environment_id, "environment id"),
    activeOwnerEpoch:
      row.active_owner_epoch === null
        ? null
        : normalizeEpoch(row.active_owner_epoch, "active owner epoch"),
    workspaceBaseManifestRef: nullableRequired(
      row.workspace_base_manifest_ref,
      "workspace base manifest ref",
    ),
    remoteWorkspaceDir: nullableRequired(row.remote_workspace_dir, "remote workspace directory"),
    workerBundleHash: nullableRequired(row.worker_bundle_hash, "worker bundle hash"),
    lastTranscriptAckCursor: normalizeCursor(
      row.last_transcript_ack_cursor,
      "transcript ACK cursor",
    ),
    lastLiveEventAckCursor: normalizeCursor(row.last_live_event_ack_cursor, "live ACK cursor"),
  };
  const recoveryError = nullableRequired(row.recovery_error, "recovery error");
  const turnClaim = parseTurnClaim(row);
  const base = {
    sessionId: row.session_id,
    agentId: row.agent_id,
    sessionKey: row.session_key,
    generation: row.transition_generation,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    stateChangedAtMs: row.state_changed_at_ms,
  };
  assertRecordShape({ state, ...parsed, recoveryError, turnClaim });
  switch (state) {
    case "local": {
      return {
        ...base,
        state,
        turnClaim: localTurnClaimForState(turnClaim, state),
        ...EMPTY_WORKER_METADATA,
      };
    }
    case "requested": {
      return {
        ...base,
        state,
        turnClaim: localTurnClaimForState(turnClaim, state),
        ...EMPTY_WORKER_METADATA,
      };
    }
    case "provisioning": {
      return {
        ...base,
        state,
        turnClaim: unclaimedTurnForState(turnClaim, state),
        ...EMPTY_WORKER_METADATA,
        environmentId: parsed.environmentId,
      };
    }
    case "syncing": {
      if (parsed.environmentId === null || parsed.workerBundleHash === null) {
        throw new Error("Syncing worker session placement requires an environment and bundle");
      }
      return {
        ...base,
        state,
        turnClaim: unclaimedTurnForState(turnClaim, state),
        ...EMPTY_WORKER_METADATA,
        environmentId: parsed.environmentId,
        workerBundleHash: parsed.workerBundleHash,
      };
    }
    case "starting": {
      if (
        parsed.environmentId === null ||
        parsed.workspaceBaseManifestRef === null ||
        parsed.remoteWorkspaceDir === null ||
        parsed.workerBundleHash === null
      ) {
        throw new Error("Starting worker session placement requires complete workspace metadata");
      }
      return {
        ...base,
        state,
        turnClaim: unclaimedTurnForState(turnClaim, state),
        ...EMPTY_WORKER_METADATA,
        environmentId: parsed.environmentId,
        workspaceBaseManifestRef: parsed.workspaceBaseManifestRef,
        remoteWorkspaceDir: parsed.remoteWorkspaceDir,
        workerBundleHash: parsed.workerBundleHash,
      };
    }
    case "active": {
      return {
        ...base,
        state,
        turnClaim: workerTurnClaimForState(turnClaim, state),
        ...ownedWorkerMetadata(parsed, state),
      };
    }
    case "draining": {
      return {
        ...base,
        state,
        turnClaim: workerTurnClaimForState(turnClaim, state),
        ...ownedWorkerMetadata(parsed, state),
      };
    }
    case "reconciling": {
      return {
        ...base,
        state,
        turnClaim: unclaimedTurnForState(turnClaim, state),
        ...ownedWorkerMetadata(parsed, state),
      };
    }
    case "reclaimed": {
      return {
        ...base,
        state,
        turnClaim: unclaimedTurnForState(turnClaim, state),
        ...ownedWorkerMetadata(parsed, state),
      };
    }
    case "failed": {
      if (recoveryError === null) {
        throw new Error("Failed worker session placement requires a recovery error");
      }
      return {
        ...base,
        state,
        turnClaim: localTurnClaimForState(turnClaim, state),
        environmentId: parsed.environmentId,
        activeOwnerEpoch: parsed.activeOwnerEpoch,
        workspaceBaseManifestRef: parsed.workspaceBaseManifestRef,
        remoteWorkspaceDir: parsed.remoteWorkspaceDir,
        workerBundleHash: parsed.workerBundleHash,
        lastTranscriptAckCursor: parsed.lastTranscriptAckCursor,
        lastLiveEventAckCursor: parsed.lastLiveEventAckCursor,
        recoveryError,
      };
    }
  }
  // Exhaustive over placement states; the return satisfies consistent-return.
  return state satisfies never;
}

export function find(
  db: DatabaseSync,
  sessionId: string,
): WorkerSessionPlacementRecord | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_session_placements")
      .selectAll()
      .where("session_id", "=", sessionId),
  );
  return row ? fromRow(row) : undefined;
}

export function getRequired(db: DatabaseSync, sessionId: string): WorkerSessionPlacementRecord {
  const record = find(db, sessionId);
  if (!record) {
    throw new Error(`Unknown worker session placement: ${sessionId}`);
  }
  return record;
}

function assertIdentity(
  record: WorkerSessionPlacementRecord,
  identity: WorkerSessionPlacementIdentity,
): void {
  if (record.agentId !== identity.agentId || record.sessionKey !== identity.sessionKey) {
    throw new Error(`Worker session placement identity changed for ${identity.sessionId}`);
  }
}

function insertLocal(
  db: DatabaseSync,
  identity: WorkerSessionPlacementIdentity,
  nowMs: number,
): WorkerSessionPlacementRecord {
  executeSqliteQuerySync(
    db,
    query(db).insertInto("worker_session_placements").values({
      session_id: identity.sessionId,
      agent_id: identity.agentId,
      session_key: identity.sessionKey,
      state: "local",
      environment_id: null,
      transition_generation: 0,
      active_owner_epoch: null,
      workspace_base_manifest_ref: null,
      remote_workspace_dir: null,
      worker_bundle_hash: null,
      last_transcript_ack_cursor: null,
      last_live_event_ack_cursor: null,
      recovery_error: null,
      turn_claim_owner: null,
      turn_claim_id: null,
      turn_claim_run_id: null,
      turn_claim_generation: null,
      turn_claim_owner_epoch: null,
      created_at_ms: nowMs,
      updated_at_ms: nowMs,
      state_changed_at_ms: nowMs,
    }),
  );
  return getRequired(db, identity.sessionId);
}

export function ensureLocal(
  db: DatabaseSync,
  identity: WorkerSessionPlacementIdentity,
  nowMs: number,
): WorkerSessionPlacementRecord {
  const current = find(db, identity.sessionId);
  if (current) {
    assertIdentity(current, identity);
    return current;
  }
  return insertLocal(db, identity, nowMs);
}

export function transitionValues(
  current: WorkerSessionPlacementRecord,
  to: WorkerSessionPlacementRecord["state"],
  patch: WorkerSessionPlacementTransitionPatch,
  nowMs: number,
): PlacementRow {
  const environmentId =
    to === "local" || to === "requested"
      ? null
      : patch.environmentId === undefined
        ? current.environmentId
        : patch.environmentId === null
          ? null
          : required(patch.environmentId, "environment id");
  const activeOwnerEpoch =
    to === "local" ||
    to === "requested" ||
    to === "provisioning" ||
    to === "syncing" ||
    to === "starting"
      ? null
      : patch.activeOwnerEpoch === undefined
        ? current.activeOwnerEpoch
        : patch.activeOwnerEpoch === null
          ? null
          : normalizeEpoch(patch.activeOwnerEpoch, "active owner epoch");
  const generation = nextGeneration(current.generation);
  const clearsWorkerMetadata = to === "local" || to === "requested";
  const values: PlacementRow = {
    session_id: current.sessionId,
    agent_id: current.agentId,
    session_key: current.sessionKey,
    state: to,
    environment_id: environmentId,
    transition_generation: generation,
    active_owner_epoch: activeOwnerEpoch,
    workspace_base_manifest_ref: clearsWorkerMetadata
      ? null
      : patch.workspaceBaseManifestRef === undefined
        ? current.workspaceBaseManifestRef
        : patch.workspaceBaseManifestRef === null
          ? null
          : required(patch.workspaceBaseManifestRef, "workspace base manifest ref"),
    remote_workspace_dir: clearsWorkerMetadata
      ? null
      : patch.remoteWorkspaceDir === undefined
        ? current.remoteWorkspaceDir
        : patch.remoteWorkspaceDir === null
          ? null
          : required(patch.remoteWorkspaceDir, "remote workspace directory"),
    worker_bundle_hash: clearsWorkerMetadata
      ? null
      : patch.workerBundleHash === undefined
        ? current.workerBundleHash
        : patch.workerBundleHash === null
          ? null
          : required(patch.workerBundleHash, "worker bundle hash"),
    last_transcript_ack_cursor: clearsWorkerMetadata
      ? null
      : patch.lastTranscriptAckCursor === undefined
        ? current.lastTranscriptAckCursor
        : normalizeCursor(patch.lastTranscriptAckCursor, "transcript ACK cursor"),
    last_live_event_ack_cursor: clearsWorkerMetadata
      ? null
      : patch.lastLiveEventAckCursor === undefined
        ? current.lastLiveEventAckCursor
        : normalizeCursor(patch.lastLiveEventAckCursor, "live ACK cursor"),
    recovery_error: clearsWorkerMetadata
      ? null
      : patch.recoveryError === undefined
        ? current.recoveryError
        : patch.recoveryError === null
          ? null
          : required(patch.recoveryError, "recovery error"),
    turn_claim_owner: null,
    turn_claim_id: null,
    turn_claim_run_id: null,
    turn_claim_generation: null,
    turn_claim_owner_epoch: null,
    created_at_ms: current.createdAtMs,
    updated_at_ms: nowMs,
    state_changed_at_ms: nowMs,
  };
  assertRecordShape({
    state: to,
    environmentId,
    activeOwnerEpoch,
    workspaceBaseManifestRef: values.workspace_base_manifest_ref,
    remoteWorkspaceDir: values.remote_workspace_dir,
    workerBundleHash: values.worker_bundle_hash,
    lastTranscriptAckCursor: values.last_transcript_ack_cursor,
    lastLiveEventAckCursor: values.last_live_event_ack_cursor,
    recoveryError: values.recovery_error,
    turnClaim: null,
  });
  return values;
}
