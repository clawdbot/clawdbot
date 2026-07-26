import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  advanceCursor,
  normalizeEpoch,
  normalizeIdentity,
  required,
  type WorkerSessionPlacementIdentity,
  type WorkerSessionPlacementRecord,
  type WorkerSessionTurnClaim,
  type WorkerSessionTurnOwner,
} from "./placement-record.js";
import { ensureLocal, find, getRequired, query, transitionValues } from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";
import { clearWorkerWorkspaceReconciliation } from "./placement-workspace-journal.js";
import {
  clearWorkerWorkspacePendingResult,
  hasAcceptedWorkerWorkspacePendingResult,
  hasWorkerWorkspacePendingResult,
  insertWorkerWorkspacePendingResult,
} from "./placement-workspace-result.js";
import {
  parseWorkerWorkspaceReconciliationPlan,
  serializeWorkerWorkspaceReconciliationPlan,
} from "./workspace-reconcile.js";

type TurnClaimReleaseWaiter = () => void;
type WorkerTurnClaimInput = WorkerSessionPlacementIdentity & {
  owner: WorkerSessionTurnOwner;
  claimId: string;
  runId: string;
};
const turnClaimReleaseWaiters = new Map<string, Map<string, Set<TurnClaimReleaseWaiter>>>();
const workspaceJournalQuery = (db: DatabaseSync) =>
  getNodeSqliteKysely<Pick<StateDatabase, "worker_workspace_reconciliations">>(db);

export class ActiveTurnClaimError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} already has an active turn claim`);
    this.name = "ActiveTurnClaimError";
  }
}

function waitersFor(path: string, sessionId: string): Set<TurnClaimReleaseWaiter> {
  let bySession = turnClaimReleaseWaiters.get(path);
  if (!bySession) {
    bySession = new Map();
    turnClaimReleaseWaiters.set(path, bySession);
  }
  let waiters = bySession.get(sessionId);
  if (!waiters) {
    waiters = new Set();
    bySession.set(sessionId, waiters);
  }
  return waiters;
}

export function signalTurnClaimRelease(path: string, sessionId: string): void {
  const bySession = turnClaimReleaseWaiters.get(path);
  const waiters = bySession?.get(sessionId);
  if (!waiters) {
    return;
  }
  bySession?.delete(sessionId);
  if (bySession?.size === 0) {
    turnClaimReleaseWaiters.delete(path);
  }
  for (const resolve of waiters) {
    resolve();
  }
}

export function createPlacementTurnClaimOps(runtime: PlacementStoreRuntime) {
  const { instanceId, path, now, read, write } = runtime;
  const claimTurnInDatabase = (
    db: DatabaseSync,
    input: WorkerTurnClaimInput,
    updatedAtMs: number,
  ): WorkerSessionTurnClaim => {
    const identity = normalizeIdentity(input);
    const claimId = required(input.claimId, "turn claim id");
    const runId = required(input.runId, "turn claim run id");
    const owner: WorkerSessionTurnOwner =
      input.owner.kind === "local"
        ? { kind: "local" }
        : {
            kind: "worker",
            environmentId: required(input.owner.environmentId, "turn owner environment id"),
            ownerEpoch: normalizeEpoch(input.owner.ownerEpoch, "turn owner epoch"),
          };
    const current = ensureLocal(db, identity, updatedAtMs);
    if (current.turnClaim) {
      throw new ActiveTurnClaimError(identity.sessionId);
    }
    if (owner.kind === "local") {
      if (current.state !== "local") {
        throw new Error(
          `Local turn rejected for session ${identity.sessionId} in placement ${current.state}`,
        );
      }
    } else if (
      current.state !== "active" ||
      current.environmentId !== owner.environmentId ||
      current.activeOwnerEpoch !== owner.ownerEpoch
    ) {
      throw new Error(`Worker turn rejected for session ${identity.sessionId}: stale owner`);
    }
    const result = executeSqliteQuerySync(
      db,
      query(db)
        .updateTable("worker_session_placements")
        .set({
          turn_claim_owner: owner.kind,
          turn_claim_id: claimId,
          turn_claim_run_id: runId,
          turn_claim_generation: current.generation,
          turn_claim_owner_epoch: owner.kind === "worker" ? owner.ownerEpoch : null,
          updated_at_ms: updatedAtMs,
        })
        .where("session_id", "=", current.sessionId)
        .where("state", "=", current.state)
        .where("transition_generation", "=", current.generation)
        .where("turn_claim_owner", "is", null),
    );
    if (result.numAffectedRows !== 1n) {
      throw new Error(`Session ${identity.sessionId} placement changed during turn admission`);
    }
    return {
      sessionId: current.sessionId,
      claimId,
      runId,
      placementGeneration: current.generation,
      owner,
    };
  };

  return {
    claimTurn(input: WorkerTurnClaimInput): WorkerSessionTurnClaim {
      return write((db) => claimTurnInDatabase(db, input, now()));
    },

    claimReclaimWorkspaceResult(input: WorkerTurnClaimInput): WorkerSessionTurnClaim {
      if (input.claimId !== input.runId || !input.claimId.startsWith("reclaim-")) {
        throw new Error(`Session ${input.sessionId} workspace result is not owned by reclaim`);
      }
      // Admission and its recovery fence are inseparable. A crash after this
      // transaction leaves startup recovery enough state to finish or abandon it.
      return write((db) => {
        const updatedAtMs = now();
        const claim = claimTurnInDatabase(db, input, updatedAtMs);
        insertWorkerWorkspacePendingResult(db, claim, updatedAtMs, instanceId);
        return claim;
      });
    },

    releaseTurn(claim: WorkerSessionTurnClaim): WorkerSessionPlacementRecord {
      const sessionId = required(claim.sessionId, "session id");
      const claimId = required(claim.claimId, "turn claim id");
      const runId = required(claim.runId, "turn claim run id");
      const released = write((db) => {
        const current = getRequired(db, sessionId);
        if (hasWorkerWorkspacePendingResult(db, sessionId)) {
          throw new Error(`Session ${sessionId} has a pending cloud workspace result`);
        }
        const persisted = current.turnClaim;
        const workerMayFinish = current.state === "active" || current.state === "draining";
        if (
          !persisted ||
          persisted.claimId !== claimId ||
          persisted.runId !== runId ||
          persisted.generation !== claim.placementGeneration ||
          persisted.owner !== claim.owner.kind ||
          (claim.owner.kind === "worker" &&
            (persisted.ownerEpoch !== claim.owner.ownerEpoch ||
              !workerMayFinish ||
              current.environmentId !== claim.owner.environmentId ||
              current.activeOwnerEpoch !== claim.owner.ownerEpoch))
        ) {
          throw new Error(`Session ${sessionId} turn claim changed before release`);
        }
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_session_placements")
            .set({
              turn_claim_owner: null,
              turn_claim_id: null,
              turn_claim_run_id: null,
              turn_claim_generation: null,
              turn_claim_owner_epoch: null,
              updated_at_ms: now(),
            })
            .where("session_id", "=", sessionId)
            .where("turn_claim_id", "=", claimId)
            .where("turn_claim_run_id", "=", runId)
            .where("turn_claim_generation", "=", claim.placementGeneration),
        );
        if (result.numAffectedRows !== 1n) {
          throw new Error(`Session ${sessionId} turn claim changed during release`);
        }
        return getRequired(db, sessionId);
      });
      signalTurnClaimRelease(path, sessionId);
      return released;
    },

    completeWorkspaceResultAndReleaseTurn(
      claim: WorkerSessionTurnClaim,
      options: { reclaim?: boolean } = {},
    ): WorkerSessionPlacementRecord {
      const sessionId = required(claim.sessionId, "session id");
      const claimId = required(claim.claimId, "turn claim id");
      const runId = required(claim.runId, "turn claim run id");
      const released = write((db) => {
        if (!hasWorkerWorkspacePendingResult(db, sessionId)) {
          throw new Error(`Session ${sessionId} has no pending cloud workspace result`);
        }
        if (!hasAcceptedWorkerWorkspacePendingResult(db, sessionId)) {
          throw new Error(`Session ${sessionId} cloud workspace result was not accepted`);
        }
        const current = getRequired(db, sessionId);
        const persisted = current.turnClaim;
        if (
          claim.owner.kind !== "worker" ||
          (current.state !== "active" && current.state !== "draining") ||
          current.environmentId !== claim.owner.environmentId ||
          current.activeOwnerEpoch !== claim.owner.ownerEpoch ||
          !persisted ||
          persisted.owner !== "worker" ||
          persisted.claimId !== claimId ||
          persisted.runId !== runId ||
          persisted.generation !== claim.placementGeneration ||
          persisted.ownerEpoch !== claim.owner.ownerEpoch
        ) {
          throw new Error(`Session ${sessionId} workspace result owner changed before release`);
        }
        const values = options.reclaim
          ? transitionValues(current, "reclaimed", {}, now())
          : {
              turn_claim_owner: null,
              turn_claim_id: null,
              turn_claim_run_id: null,
              turn_claim_generation: null,
              turn_claim_owner_epoch: null,
              updated_at_ms: now(),
            };
        clearWorkerWorkspacePendingResult(db, sessionId);
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_session_placements")
            .set(values)
            .where("session_id", "=", sessionId)
            .where("state", "=", current.state)
            .where("transition_generation", "=", current.generation)
            .where("turn_claim_id", "=", claimId)
            .where("turn_claim_run_id", "=", runId),
        );
        if (result.numAffectedRows !== 1n) {
          throw new Error(`Session ${sessionId} workspace result changed during release`);
        }
        return getRequired(db, sessionId);
      });
      signalTurnClaimRelease(path, sessionId);
      return released;
    },

    cancelWorkspaceResultAndReleaseTurn(
      claim: WorkerSessionTurnClaim,
    ): WorkerSessionPlacementRecord {
      const sessionId = required(claim.sessionId, "session id");
      const claimId = required(claim.claimId, "turn claim id");
      const runId = required(claim.runId, "turn claim run id");
      if (claimId !== runId || !claimId.startsWith("reclaim-")) {
        throw new Error(`Session ${sessionId} workspace result is not owned by reclaim`);
      }
      // A failed stop must not expose a claim without its recovery fence (or vice
      // versa), because either half-state permanently blocks the next reclaim.
      const released = write((db) => {
        const current = getRequired(db, sessionId);
        const persisted = current.turnClaim;
        const pending = executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<Pick<StateDatabase, "worker_workspace_pending_results">>(db)
            .selectFrom("worker_workspace_pending_results")
            .selectAll()
            .where("session_id", "=", sessionId),
        ).rows[0];
        if (
          claim.owner.kind !== "worker" ||
          (current.state !== "active" && current.state !== "draining") ||
          current.environmentId !== claim.owner.environmentId ||
          current.activeOwnerEpoch !== claim.owner.ownerEpoch ||
          !persisted ||
          persisted.owner !== "worker" ||
          persisted.claimId !== claimId ||
          persisted.runId !== runId ||
          persisted.generation !== claim.placementGeneration ||
          persisted.ownerEpoch !== claim.owner.ownerEpoch ||
          !pending ||
          pending.environment_id !== claim.owner.environmentId ||
          pending.owner_epoch !== claim.owner.ownerEpoch ||
          pending.placement_generation !== claim.placementGeneration ||
          pending.claim_id !== claimId ||
          pending.run_id !== runId ||
          pending.workspace_accepted_at_ms !== null
        ) {
          throw new Error(
            `Session ${sessionId} workspace result owner changed before cancellation`,
          );
        }
        clearWorkerWorkspacePendingResult(db, sessionId);
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_session_placements")
            .set({
              turn_claim_owner: null,
              turn_claim_id: null,
              turn_claim_run_id: null,
              turn_claim_generation: null,
              turn_claim_owner_epoch: null,
              updated_at_ms: now(),
            })
            .where("session_id", "=", sessionId)
            .where("state", "=", current.state)
            .where("transition_generation", "=", current.generation)
            .where("turn_claim_id", "=", claimId)
            .where("turn_claim_run_id", "=", runId),
        );
        if (result.numAffectedRows !== 1n) {
          throw new Error(`Session ${sessionId} workspace result changed during cancellation`);
        }
        return getRequired(db, sessionId);
      });
      signalTurnClaimRelease(path, sessionId);
      return released;
    },

    clearLocalTurnClaimsAfterRestart(): number {
      const clearedSessionIds = write((db) => {
        const sessionIds = executeSqliteQuerySync(
          db,
          query(db)
            .selectFrom("worker_session_placements")
            .select("session_id")
            .where("turn_claim_owner", "=", "local"),
        ).rows.map((row) => row.session_id);
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_session_placements")
            .set({
              turn_claim_owner: null,
              turn_claim_id: null,
              turn_claim_run_id: null,
              turn_claim_generation: null,
              turn_claim_owner_epoch: null,
              updated_at_ms: now(),
            })
            .where("turn_claim_owner", "=", "local"),
        );
        if (result.numAffectedRows !== BigInt(sessionIds.length)) {
          throw new Error("Local turn claims changed during restart recovery");
        }
        return sessionIds;
      });
      for (const sessionId of clearedSessionIds) {
        signalTurnClaimRelease(path, sessionId);
      }
      return clearedSessionIds.length;
    },

    async waitForTurnClaimRelease(
      sessionIdInput: string,
      waitOptions: { timeoutMs: number; signal?: AbortSignal },
    ): Promise<void> {
      const sessionId = required(sessionIdInput, "session id");
      if (!Number.isSafeInteger(waitOptions.timeoutMs) || waitOptions.timeoutMs < 0) {
        throw new Error("Worker session turn claim wait timeout must be a non-negative integer");
      }
      if (!find(read(), sessionId)?.turnClaim) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const waiters = waitersFor(path, sessionId);
        const finish = (error?: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          waitOptions.signal?.removeEventListener("abort", onAbort);
          waiters.delete(onRelease);
          if (waiters.size === 0) {
            const bySession = turnClaimReleaseWaiters.get(path);
            bySession?.delete(sessionId);
            if (bySession?.size === 0) {
              turnClaimReleaseWaiters.delete(path);
            }
          }
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        };
        const onRelease = () => finish();
        const onAbort = () => finish(new Error(`Turn claim wait aborted for session ${sessionId}`));
        const timer = setTimeout(
          () => finish(new Error(`Timed out waiting for session ${sessionId} turn claim release`)),
          waitOptions.timeoutMs,
        );
        waiters.add(onRelease);
        waitOptions.signal?.addEventListener("abort", onAbort, { once: true });
        // Register first, then reread. This closes the release-between-check-and-wait race.
        if (!find(read(), sessionId)?.turnClaim) {
          finish();
        } else if (waitOptions.signal?.aborted) {
          onAbort();
        }
      });
    },

    validateTurnClaim(claim: WorkerSessionTurnClaim): boolean {
      const current = find(read(), required(claim.sessionId, "session id"));
      const persisted = current?.turnClaim;
      return (
        persisted !== undefined &&
        persisted !== null &&
        persisted.claimId === claim.claimId &&
        persisted.runId === claim.runId &&
        persisted.generation === claim.placementGeneration &&
        persisted.owner === claim.owner.kind &&
        (claim.owner.kind === "local" ||
          (persisted.ownerEpoch === claim.owner.ownerEpoch &&
            (current?.state === "active" || current?.state === "draining") &&
            current.environmentId === claim.owner.environmentId &&
            current.activeOwnerEpoch === claim.owner.ownerEpoch))
      );
    },

    updateAckCursors(input: {
      claim: WorkerSessionTurnClaim;
      transcript?: number;
      liveEvent?: number;
      workspaceResultPending?: boolean;
    }): WorkerSessionPlacementRecord {
      const sessionId = required(input.claim.sessionId, "session id");
      const claimId = required(input.claim.claimId, "turn claim id");
      const runId = required(input.claim.runId, "turn claim run id");
      if (
        !Number.isSafeInteger(input.claim.placementGeneration) ||
        input.claim.placementGeneration < 0
      ) {
        throw new Error("Worker session placement turn claim generation is invalid");
      }
      if (input.claim.owner.kind !== "worker") {
        throw new Error("Only a worker turn claim can acknowledge worker cursors");
      }
      const placementGeneration = input.claim.placementGeneration;
      const environmentId = required(input.claim.owner.environmentId, "environment id");
      const ownerEpoch = normalizeEpoch(input.claim.owner.ownerEpoch, "active owner epoch");
      return write((db) => {
        const current = getRequired(db, sessionId);
        const persisted = current.turnClaim;
        const workerMayFinish = current.state === "active" || current.state === "draining";
        if (
          !workerMayFinish ||
          current.environmentId !== environmentId ||
          current.activeOwnerEpoch !== ownerEpoch ||
          persisted?.owner !== "worker" ||
          persisted.claimId !== claimId ||
          persisted.runId !== runId ||
          persisted.generation !== placementGeneration ||
          persisted.ownerEpoch !== ownerEpoch
        ) {
          throw new Error(`Cannot ACK stale worker turn for session ${sessionId}`);
        }
        // Successful RPC replays can carry an older sequence. Preserve the
        // durable high-water mark while acknowledging the idempotent replay.
        const transcript = advanceCursor(
          current.lastTranscriptAckCursor,
          input.transcript,
          "transcript ACK cursor",
        );
        const liveEvent = advanceCursor(
          current.lastLiveEventAckCursor,
          input.liveEvent,
          "live ACK cursor",
        );
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_session_placements")
            .set({
              last_transcript_ack_cursor: transcript,
              last_live_event_ack_cursor: liveEvent,
              updated_at_ms: now(),
            })
            .where("session_id", "=", sessionId)
            .where("state", "=", current.state)
            .where("transition_generation", "=", current.generation)
            .where("environment_id", "=", environmentId)
            .where("active_owner_epoch", "=", ownerEpoch)
            .where("turn_claim_owner", "=", "worker")
            .where("turn_claim_id", "=", claimId)
            .where("turn_claim_run_id", "=", runId)
            .where("turn_claim_generation", "=", placementGeneration)
            .where("turn_claim_owner_epoch", "=", ownerEpoch),
        );
        if (result.numAffectedRows !== 1n) {
          throw new Error(`Worker session placement ${sessionId} changed during ACK`);
        }
        if (input.workspaceResultPending) {
          // The terminal event is not ACKed until crash recovery has a durable
          // fence protecting remote workspace results from stale-claim teardown.
          insertWorkerWorkspacePendingResult(db, input.claim, now(), instanceId);
        }
        return getRequired(db, sessionId);
      });
    },

    updateWorkspaceBaseManifest(input: {
      claim: WorkerSessionTurnClaim;
      manifestRef: string;
    }): WorkerSessionPlacementRecord {
      const sessionId = required(input.claim.sessionId, "session id");
      const claimId = required(input.claim.claimId, "turn claim id");
      const runId = required(input.claim.runId, "turn claim run id");
      const manifestRef = required(input.manifestRef, "workspace base manifest ref");
      if (!/^sha256:[a-f0-9]{64}$/u.test(manifestRef)) {
        throw new Error("Worker workspace base manifest reference is invalid");
      }
      if (input.claim.owner.kind !== "worker") {
        throw new Error("Only a worker turn claim can advance its workspace manifest");
      }
      const placementGeneration = input.claim.placementGeneration;
      const environmentId = required(input.claim.owner.environmentId, "environment id");
      const ownerEpoch = normalizeEpoch(input.claim.owner.ownerEpoch, "active owner epoch");
      return write((db) => {
        const current = getRequired(db, sessionId);
        const persisted = current.turnClaim;
        if (
          (current.state !== "active" && current.state !== "draining") ||
          current.environmentId !== environmentId ||
          current.activeOwnerEpoch !== ownerEpoch ||
          persisted?.owner !== "worker" ||
          persisted.claimId !== claimId ||
          persisted.runId !== runId ||
          persisted.generation !== placementGeneration ||
          persisted.ownerEpoch !== ownerEpoch
        ) {
          throw new Error(`Cannot advance stale worker workspace for session ${sessionId}`);
        }
        const reconciliation = executeSqliteQuerySync(
          db,
          workspaceJournalQuery(db)
            .selectFrom("worker_workspace_reconciliations")
            .selectAll()
            .where("session_id", "=", sessionId),
        ).rows[0];
        const reconciliationPlan = reconciliation
          ? parseWorkerWorkspaceReconciliationPlan(reconciliation.plan_json)
          : undefined;
        if (
          reconciliation &&
          reconciliation.base_manifest_ref !== current.workspaceBaseManifestRef &&
          reconciliationPlan?.appliedManifestRef !== current.workspaceBaseManifestRef
        ) {
          throw new Error(`Worker workspace journal owner is stale for session ${sessionId}`);
        }
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_session_placements")
            .set({ workspace_base_manifest_ref: manifestRef, updated_at_ms: now() })
            .where("session_id", "=", sessionId)
            .where("state", "=", current.state)
            .where("transition_generation", "=", current.generation)
            .where("environment_id", "=", environmentId)
            .where("active_owner_epoch", "=", ownerEpoch)
            .where("turn_claim_owner", "=", "worker")
            .where("turn_claim_id", "=", claimId)
            .where("turn_claim_run_id", "=", runId)
            .where("turn_claim_generation", "=", placementGeneration)
            .where("turn_claim_owner_epoch", "=", ownerEpoch),
        );
        if (result.numAffectedRows !== 1n) {
          throw new Error(`Worker session workspace ${sessionId} changed during reconciliation`);
        }
        if (reconciliation) {
          const markedPlan = serializeWorkerWorkspaceReconciliationPlan({
            ...reconciliationPlan!,
            appliedManifestRef: manifestRef,
            basePack: reconciliation.base_pack,
          });
          const marked = executeSqliteQuerySync(
            db,
            workspaceJournalQuery(db)
              .updateTable("worker_workspace_reconciliations")
              .set({ plan_json: markedPlan })
              .where("session_id", "=", sessionId)
              .where("base_manifest_ref", "=", reconciliation.base_manifest_ref),
          );
          if (marked.numAffectedRows !== 1n) {
            throw new Error(`Worker workspace journal changed for session ${sessionId}`);
          }
        }
        return getRequired(db, sessionId);
      });
    },

    acceptIdleWorkspaceReconciliation(input: {
      sessionId: string;
      environmentId: string;
      ownerEpoch: number;
      expectedGeneration: number;
      manifestRef: string;
    }): WorkerSessionPlacementRecord {
      const sessionId = required(input.sessionId, "session id");
      const environmentId = required(input.environmentId, "environment id");
      const ownerEpoch = normalizeEpoch(input.ownerEpoch, "active owner epoch");
      const manifestRef = required(input.manifestRef, "workspace base manifest ref");
      if (!/^sha256:[a-f0-9]{64}$/u.test(manifestRef)) {
        throw new Error("Worker workspace base manifest reference is invalid");
      }
      return write((db) => {
        const current = getRequired(db, sessionId);
        if (
          current.state !== "active" ||
          current.generation !== input.expectedGeneration ||
          current.environmentId !== environmentId ||
          current.activeOwnerEpoch !== ownerEpoch ||
          current.turnClaim !== null
        ) {
          throw new Error(`Cannot accept stale idle worker workspace for session ${sessionId}`);
        }
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_session_placements")
            .set({ workspace_base_manifest_ref: manifestRef, updated_at_ms: now() })
            .where("session_id", "=", sessionId)
            .where("state", "=", "active")
            .where("transition_generation", "=", input.expectedGeneration)
            .where("environment_id", "=", environmentId)
            .where("active_owner_epoch", "=", ownerEpoch)
            .where("turn_claim_owner", "is", null),
        );
        if (result.numAffectedRows !== 1n) {
          throw new Error(`Worker session workspace ${sessionId} changed during reconciliation`);
        }
        clearWorkerWorkspaceReconciliation(db, sessionId);
        return getRequired(db, sessionId);
      });
    },
  };
}
