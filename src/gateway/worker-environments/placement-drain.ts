import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  assertRecordShape,
  normalizeEpoch,
  required,
  type WorkerSessionPlacementRecord,
} from "./placement-record.js";
import { getRequired, query, transitionValues } from "./placement-row-codec.js";
import { clearWorkerWorkspaceReconciliation } from "./placement-workspace-journal.js";
import { hasWorkerWorkspacePendingResult } from "./placement-workspace-result.js";

export function drainWorkerSessionPlacement(
  db: DatabaseSync,
  input: {
    sessionId: string;
    environmentId: string;
    ownerEpoch: number;
    expectedGeneration: number;
    workspaceBaseManifestRef?: string;
    allowPendingWorkspaceResult?: boolean;
  },
  nowMs: number,
): WorkerSessionPlacementRecord {
  const sessionId = required(input.sessionId, "session id");
  const environmentId = required(input.environmentId, "environment id");
  const ownerEpoch = normalizeEpoch(input.ownerEpoch, "active owner epoch");
  const current = getRequired(db, sessionId);
  if (
    current.state !== "active" ||
    current.generation !== input.expectedGeneration ||
    current.environmentId !== environmentId ||
    current.activeOwnerEpoch !== ownerEpoch
  ) {
    throw new Error(`Cannot drain stale worker placement for session ${sessionId}`);
  }
  if (!input.allowPendingWorkspaceResult && hasWorkerWorkspacePendingResult(db, sessionId)) {
    throw new Error(`Cannot drain session ${sessionId} with a pending cloud workspace result`);
  }
  // Draining closes new admission first. The already-admitted worker may
  // finish under its old claim before reconciliation advances ownership.
  const values = transitionValues(
    current,
    "draining",
    input.workspaceBaseManifestRef === undefined
      ? {}
      : { workspaceBaseManifestRef: input.workspaceBaseManifestRef },
    nowMs,
  );
  const turnClaim = current.turnClaim;
  if (turnClaim) {
    values.turn_claim_owner = turnClaim.owner;
    values.turn_claim_id = turnClaim.claimId;
    values.turn_claim_run_id = turnClaim.runId;
    values.turn_claim_generation = turnClaim.generation;
    values.turn_claim_owner_epoch = turnClaim.ownerEpoch;
  }
  assertRecordShape({
    state: "draining",
    executionMode: current.executionMode,
    environmentId,
    activeOwnerEpoch: ownerEpoch,
    workspaceBaseManifestRef: values.workspace_base_manifest_ref,
    remoteWorkspaceDir: values.remote_workspace_dir,
    workerBundleHash: values.worker_bundle_hash,
    lastTranscriptAckCursor: values.last_transcript_ack_cursor,
    lastLiveEventAckCursor: values.last_live_event_ack_cursor,
    recoveryError: values.recovery_error,
    terminalReason: values.terminal_reason,
    terminalAtMs: values.terminal_at_ms,
    turnClaim,
  });
  const result = executeSqliteQuerySync(
    db,
    query(db)
      .updateTable("worker_session_placements")
      .set(values)
      .where("session_id", "=", sessionId)
      .where("state", "=", "active")
      .where("transition_generation", "=", current.generation)
      .where("environment_id", "=", environmentId)
      .where("active_owner_epoch", "=", ownerEpoch),
  );
  if (result.numAffectedRows !== 1n) {
    throw new Error(`Worker session placement ${sessionId} changed during drain`);
  }
  if (input.workspaceBaseManifestRef !== undefined) {
    clearWorkerWorkspaceReconciliation(db, sessionId, input.workspaceBaseManifestRef);
  }
  return getRequired(db, sessionId);
}
