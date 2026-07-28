import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  assertRecordShape,
  nextGeneration,
  normalizeEpoch,
  normalizeIdentity,
  required,
  type WorkerSessionPlacementIdentity,
  type WorkerSessionPlacementRecord,
  type WorkerSessionPlacementTransitionPatch,
  type WorkerSessionTurnClaim,
  type WorkerWorkspaceResultConflict,
} from "./placement-record.js";
import {
  ensureLocal,
  find,
  fromRow,
  getRequired,
  query,
  transitionValues,
} from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";
import {
  canTransitionWorkerSessionPlacement,
  type WorkerSessionPlacementState,
} from "./placement-state.js";
import { createPlacementTurnClaimOps, signalTurnClaimRelease } from "./placement-turn-claims.js";
import {
  clearWorkerWorkspaceReconciliation,
  createPlacementWorkspaceJournalOps,
} from "./placement-workspace-journal.js";
import {
  createPlacementWorkspaceResultOps,
  hasWorkerWorkspacePendingResult,
} from "./placement-workspace-result.js";
import { projectWorkspaceResultConflict } from "./workspace-conflicts.js";

function exactConflictPath(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Worker placement conflict path is required");
  }
  return value;
}

export type { WorkerSessionPlacementRecord, WorkerSessionTurnClaim } from "./placement-record.js";

function updateTransition(
  db: DatabaseSync,
  current: WorkerSessionPlacementRecord,
  to: WorkerSessionPlacementState,
  patch: WorkerSessionPlacementTransitionPatch,
  nowMs: number,
): WorkerSessionPlacementRecord {
  const values = transitionValues(current, to, patch, nowMs);
  const result = executeSqliteQuerySync(
    db,
    query(db)
      .updateTable("worker_session_placements")
      .set(values)
      .where("session_id", "=", current.sessionId)
      .where("state", "=", current.state)
      .where("transition_generation", "=", current.generation)
      .where("turn_claim_owner", "is", null),
  );
  if (result.numAffectedRows !== 1n) {
    throw new Error(`Worker session placement ${current.sessionId} changed during transition`);
  }
  return getRequired(db, current.sessionId);
}

export function createWorkerSessionPlacementStore(
  options: { database?: OpenClawStateDatabase; now?: () => number } = {},
) {
  const path = (options.database ?? openOpenClawStateDatabase()).path;
  const now = options.now ?? Date.now;
  const runtime: PlacementStoreRuntime = {
    path,
    instanceId: randomUUID(),
    now,
    read: () => openOpenClawStateDatabase({ path }).db,
    write: (operation) => runOpenClawStateWriteTransaction(({ db }) => operation(db), { path }),
  };
  const { read, write } = runtime;
  const workspaceResultConflicts = new Map<string, WorkerWorkspaceResultConflict>();
  const withWorkspaceResultConflict = (
    record: WorkerSessionPlacementRecord | undefined,
  ): WorkerSessionPlacementRecord | undefined => {
    if (!record) {
      return undefined;
    }
    const conflict = workspaceResultConflicts.get(record.sessionId);
    return conflict ? { ...record, workspaceResultConflict: conflict } : record;
  };

  const requireClaimOwner = (claim: WorkerSessionTurnClaim): void => {
    const current = find(read(), required(claim.sessionId, "session id"));
    const persisted = current?.turnClaim;
    if (
      claim.owner.kind !== "worker" ||
      (current?.state !== "active" && current?.state !== "draining") ||
      current.environmentId !== claim.owner.environmentId ||
      current.activeOwnerEpoch !== claim.owner.ownerEpoch ||
      persisted?.owner !== "worker" ||
      persisted.claimId !== claim.claimId ||
      persisted.runId !== claim.runId ||
      persisted.generation !== claim.placementGeneration ||
      persisted.ownerEpoch !== claim.owner.ownerEpoch
    ) {
      throw new Error(`Session ${claim.sessionId} workspace result conflict owner changed`);
    }
  };

  return {
    ...createPlacementTurnClaimOps(runtime),
    ...createPlacementWorkspaceJournalOps(runtime),
    ...createPlacementWorkspaceResultOps(runtime),

    get(sessionId: string): WorkerSessionPlacementRecord | undefined {
      return withWorkspaceResultConflict(find(read(), required(sessionId, "session id")));
    },

    getMany(sessionIds: readonly string[]): ReadonlyMap<string, WorkerSessionPlacementRecord> {
      const normalizedIds = [
        ...new Set(sessionIds.map((sessionId) => required(sessionId, "session id"))),
      ];
      const records = new Map<string, WorkerSessionPlacementRecord>();
      const db = read();
      for (let offset = 0; offset < normalizedIds.length; offset += 250) {
        const chunk = normalizedIds.slice(offset, offset + 250);
        for (const row of executeSqliteQuerySync(
          db,
          query(db)
            .selectFrom("worker_session_placements")
            .selectAll()
            .where("session_id", "in", chunk),
        ).rows) {
          const record = fromRow(row);
          records.set(record.sessionId, withWorkspaceResultConflict(record)!);
        }
      }
      return records;
    },

    recordWorkspaceResultConflict(
      claim: WorkerSessionTurnClaim,
      conflict: WorkerWorkspaceResultConflict | undefined,
    ): void {
      requireClaimOwner(claim);
      if (!conflict) {
        workspaceResultConflicts.delete(claim.sessionId);
        return;
      }
      const paths = conflict.paths.map(exactConflictPath);
      const stagedResultRef = required(conflict.stagedResultRef, "staged result ref");
      if (
        paths.length === 0 ||
        !/^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u.test(stagedResultRef)
      ) {
        throw new Error("Cloud workspace result conflict projection is invalid");
      }
      workspaceResultConflicts.set(
        claim.sessionId,
        projectWorkspaceResultConflict(paths, stagedResultRef, conflict.totalCount),
      );
    },

    startDispatch(input: WorkerSessionPlacementIdentity): WorkerSessionPlacementRecord {
      const identity = normalizeIdentity(input);
      return write((db) => {
        const current = ensureLocal(db, identity, now());
        if (current.state !== "local" && current.state !== "reclaimed") {
          throw new Error(
            `Cannot dispatch session ${identity.sessionId} from placement ${current.state}`,
          );
        }
        const updatedAtMs = now();
        // Preserve an in-flight local claim while closing admission. Reclaimed
        // placement has no live owner and starts a fresh worker generation.
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_session_placements")
            .set({
              state: "requested",
              environment_id: null,
              transition_generation: nextGeneration(current.generation),
              active_owner_epoch: null,
              workspace_base_manifest_ref: null,
              remote_workspace_dir: null,
              worker_bundle_hash: null,
              last_transcript_ack_cursor: null,
              last_live_event_ack_cursor: null,
              recovery_error: null,
              updated_at_ms: updatedAtMs,
              state_changed_at_ms: updatedAtMs,
            })
            .where("session_id", "=", current.sessionId)
            .where("state", "=", current.state)
            .where("transition_generation", "=", current.generation),
        );
        if (result.numAffectedRows !== 1n) {
          throw new Error(
            `Session ${identity.sessionId} placement changed during dispatch barrier`,
          );
        }
        return getRequired(db, identity.sessionId);
      });
    },

    transition(input: {
      sessionId: string;
      from: WorkerSessionPlacementState;
      to: WorkerSessionPlacementState;
      expectedGeneration: number;
      patch?: WorkerSessionPlacementTransitionPatch;
    }): WorkerSessionPlacementRecord {
      if (!canTransitionWorkerSessionPlacement(input.from, input.to)) {
        throw new Error(
          `Illegal worker session placement transition: ${input.from} -> ${input.to}`,
        );
      }
      if (input.from === "draining" && input.to === "reconciling") {
        throw new Error("Use startReconcile after fencing the drained worker environment");
      }
      const sessionId = required(input.sessionId, "session id");
      return write((db) => {
        const current = getRequired(db, sessionId);
        if (current.state !== input.from || current.generation !== input.expectedGeneration) {
          throw new Error(
            `Worker session placement ${sessionId} changed: expected ${input.from}@${input.expectedGeneration}, found ${current.state}@${current.generation}`,
          );
        }
        if (current.turnClaim) {
          throw new Error(`Cannot transition session ${sessionId} during an active turn`);
        }
        return updateTransition(db, current, input.to, input.patch ?? {}, now());
      });
    },

    startDrain(input: {
      sessionId: string;
      environmentId: string;
      ownerEpoch: number;
      expectedGeneration: number;
      workspaceBaseManifestRef?: string;
    }): WorkerSessionPlacementRecord {
      const sessionId = required(input.sessionId, "session id");
      const environmentId = required(input.environmentId, "environment id");
      const ownerEpoch = normalizeEpoch(input.ownerEpoch, "active owner epoch");
      return write((db) => {
        const current = getRequired(db, sessionId);
        if (
          current.state !== "active" ||
          current.generation !== input.expectedGeneration ||
          current.environmentId !== environmentId ||
          current.activeOwnerEpoch !== ownerEpoch
        ) {
          throw new Error(`Cannot drain stale worker placement for session ${sessionId}`);
        }
        if (hasWorkerWorkspacePendingResult(db, sessionId)) {
          throw new Error(
            `Cannot drain session ${sessionId} with a pending cloud workspace result`,
          );
        }
        // Draining closes new admission first. The already-admitted worker may
        // finish under its old claim before reconciliation advances ownership.
        const values = transitionValues(
          current,
          "draining",
          input.workspaceBaseManifestRef === undefined
            ? {}
            : { workspaceBaseManifestRef: input.workspaceBaseManifestRef },
          now(),
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
          environmentId,
          activeOwnerEpoch: ownerEpoch,
          workspaceBaseManifestRef: values.workspace_base_manifest_ref,
          remoteWorkspaceDir: values.remote_workspace_dir,
          workerBundleHash: values.worker_bundle_hash,
          lastTranscriptAckCursor: values.last_transcript_ack_cursor,
          lastLiveEventAckCursor: values.last_live_event_ack_cursor,
          recoveryError: values.recovery_error,
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
      });
    },

    finishReclaim(input: {
      sessionId: string;
      environmentId: string;
      ownerEpoch: number;
      expectedGeneration: number;
    }): WorkerSessionPlacementRecord {
      const sessionId = required(input.sessionId, "session id");
      const environmentId = required(input.environmentId, "environment id");
      const ownerEpoch = normalizeEpoch(input.ownerEpoch, "active owner epoch");
      return write((db) => {
        const current = getRequired(db, sessionId);
        if (
          current.state !== "active" ||
          current.generation !== input.expectedGeneration ||
          current.environmentId !== environmentId ||
          current.activeOwnerEpoch !== ownerEpoch ||
          current.turnClaim !== null ||
          hasWorkerWorkspacePendingResult(db, sessionId)
        ) {
          throw new Error(`Cannot finish stale worker reclaim for session ${sessionId}`);
        }
        return updateTransition(db, current, "reclaimed", {}, now());
      });
    },

    startReconcile(input: {
      sessionId: string;
      environmentId: string;
      ownerEpoch: number;
      expectedGeneration: number;
    }): WorkerSessionPlacementRecord {
      const sessionId = required(input.sessionId, "session id");
      const environmentId = required(input.environmentId, "environment id");
      const ownerEpoch = normalizeEpoch(input.ownerEpoch, "active owner epoch");
      const outcome = write((db) => {
        const current = getRequired(db, sessionId);
        if (
          current.state !== "draining" ||
          current.generation !== input.expectedGeneration ||
          current.environmentId !== environmentId ||
          current.activeOwnerEpoch !== ownerEpoch
        ) {
          throw new Error(`Cannot reconcile stale worker placement for session ${sessionId}`);
        }
        if (hasWorkerWorkspacePendingResult(db, sessionId)) {
          throw new Error(
            `Cannot reconcile session ${sessionId} with a pending cloud workspace result`,
          );
        }
        // Clear the last claim in the same CAS that opens post-worker
        // reconciliation. Pending results block this authority fence.
        const releasedClaim = current.turnClaim !== null;
        const values = transitionValues(current, "reconciling", {}, now());
        const update = query(db)
          .updateTable("worker_session_placements")
          .set(values)
          .where("session_id", "=", sessionId)
          .where("state", "=", "draining")
          .where("transition_generation", "=", current.generation)
          .where("environment_id", "=", environmentId)
          .where("active_owner_epoch", "=", ownerEpoch);
        const guardedUpdate = current.turnClaim
          ? update
              .where("turn_claim_owner", "=", "worker")
              .where("turn_claim_id", "=", current.turnClaim.claimId)
              .where("turn_claim_run_id", "=", current.turnClaim.runId)
              .where("turn_claim_generation", "=", current.turnClaim.generation)
              .where("turn_claim_owner_epoch", "=", current.turnClaim.ownerEpoch)
          : update.where("turn_claim_owner", "is", null);
        const result = executeSqliteQuerySync(db, guardedUpdate);
        if (result.numAffectedRows !== 1n) {
          throw new Error(`Worker session placement ${sessionId} changed during reconcile`);
        }
        return { record: getRequired(db, sessionId), releasedClaim };
      });
      if (outcome.releasedClaim) {
        signalTurnClaimRelease(path, sessionId);
      }
      return outcome.record;
    },

    validateWorkerOwner(input: {
      sessionId: string;
      environmentId: string;
      ownerEpoch: number;
    }): boolean {
      const current = find(read(), required(input.sessionId, "session id"));
      return (
        current?.state === "active" &&
        current.environmentId === required(input.environmentId, "environment id") &&
        current.activeOwnerEpoch === normalizeEpoch(input.ownerEpoch, "active owner epoch")
      );
    },

    fail(input: {
      sessionId: string;
      recoveryError: string;
      expectedGeneration?: number;
    }): WorkerSessionPlacementRecord {
      const sessionId = required(input.sessionId, "session id");
      const recoveryError = required(input.recoveryError, "recovery error");
      const outcome = write((db) => {
        const current = getRequired(db, sessionId);
        if (
          input.expectedGeneration !== undefined &&
          current.generation !== input.expectedGeneration
        ) {
          throw new Error(`Worker session placement ${sessionId} changed before failure`);
        }
        if (current.state === "failed") {
          const result = executeSqliteQuerySync(
            db,
            query(db)
              .updateTable("worker_session_placements")
              .set({ recovery_error: recoveryError, updated_at_ms: now() })
              .where("session_id", "=", sessionId)
              .where("state", "=", "failed")
              .where("transition_generation", "=", current.generation),
          );
          if (result.numAffectedRows !== 1n) {
            throw new Error(`Worker session placement ${sessionId} changed during failure update`);
          }
          return { record: getRequired(db, sessionId), releasedClaim: false };
        }
        if (!canTransitionWorkerSessionPlacement(current.state, "failed")) {
          throw new Error(`Cannot fail worker session placement from ${current.state}`);
        }
        const localClaim = current.turnClaim?.owner === "local" ? current.turnClaim : null;
        const updatedAtMs = now();
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_session_placements")
            .set({
              state: "failed",
              transition_generation: nextGeneration(current.generation),
              recovery_error: recoveryError,
              turn_claim_owner: localClaim ? "local" : null,
              turn_claim_id: localClaim?.claimId ?? null,
              turn_claim_run_id: localClaim?.runId ?? null,
              turn_claim_generation: localClaim?.generation ?? null,
              turn_claim_owner_epoch: null,
              updated_at_ms: updatedAtMs,
              state_changed_at_ms: updatedAtMs,
            })
            .where("session_id", "=", sessionId)
            .where("state", "=", current.state)
            .where("transition_generation", "=", current.generation),
        );
        if (result.numAffectedRows !== 1n) {
          throw new Error(`Worker session placement ${sessionId} changed during failure`);
        }
        return {
          record: getRequired(db, sessionId),
          releasedClaim: current.turnClaim?.owner === "worker",
        };
      });
      if (outcome.releasedClaim) {
        signalTurnClaimRelease(path, sessionId);
      }
      return outcome.record;
    },

    adoptActive(input: {
      sessionId: string;
      environmentId: string;
      ownerEpoch: number;
      expectedGeneration?: number;
    }): WorkerSessionPlacementRecord {
      const sessionId = required(input.sessionId, "session id");
      const environmentId = required(input.environmentId, "environment id");
      const ownerEpoch = normalizeEpoch(input.ownerEpoch, "active owner epoch");
      const current = getRequired(read(), sessionId);
      if (
        current.state !== "active" ||
        current.environmentId !== environmentId ||
        current.activeOwnerEpoch !== ownerEpoch ||
        (input.expectedGeneration !== undefined && current.generation !== input.expectedGeneration)
      ) {
        throw new Error(`Cannot adopt stale worker placement for session ${sessionId}`);
      }
      return current;
    },

    listForReconcile(): WorkerSessionPlacementRecord[] {
      const db = read();
      return executeSqliteQuerySync(
        db,
        query(db)
          .selectFrom("worker_session_placements")
          .selectAll()
          .where("state", "not in", ["local", "reclaimed"])
          .orderBy("updated_at_ms")
          .orderBy("session_id"),
      ).rows.map((row) => withWorkspaceResultConflict(fromRow(row))!);
    },

    list(): WorkerSessionPlacementRecord[] {
      const db = read();
      return executeSqliteQuerySync(
        db,
        query(db).selectFrom("worker_session_placements").selectAll().orderBy("session_id"),
      ).rows.map((row) => withWorkspaceResultConflict(fromRow(row))!);
    },
  };
}

export type WorkerSessionPlacementStore = ReturnType<typeof createWorkerSessionPlacementStore>;
