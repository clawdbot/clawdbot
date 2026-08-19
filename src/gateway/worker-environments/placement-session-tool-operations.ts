import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { generateSecureToken } from "../../infra/secure-random.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import {
  isCurrentPlacementTurnClaim,
  required,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";
import { find, getRequired, query } from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";

type WorkerSessionToolOperationStart =
  | { kind: "execute"; operationSeed: string; childSessionKey?: string }
  | { kind: "in-progress" }
  | { kind: "completed"; resultJson: string }
  | { kind: "unknown" }
  | { kind: "capacity" }
  | { kind: "conflict" }
  | { kind: "unauthorized" };

type WorkerTurnToolStateIdentity = {
  sessionId: string;
  claimId: string;
};

type WorkerSessionToolOperationWaiter = (error?: Error) => void;

export const MAX_RUNNING_WORKER_SESSION_TOOL_OPERATIONS = 4;

const workerSessionToolOperationWaiters = resolveGlobalMap<
  string,
  Map<string, Set<WorkerSessionToolOperationWaiter>>
>(Symbol.for("openclaw.workerSessionToolOperationWaiters"), (waitersByPath) => {
  const error = new Error("Gateway lifecycle ended while waiting for worker session operations");
  for (const byClaim of waitersByPath.values()) {
    for (const waiters of byClaim.values()) {
      for (const reject of waiters) {
        reject(error);
      }
    }
  }
  waitersByPath.clear();
});

function workerSessionToolOperationWaiterKey(identity: WorkerTurnToolStateIdentity): string {
  return `${identity.sessionId}\0${identity.claimId}`;
}

function workerSessionToolOperationWaitersFor(
  path: string,
  identity: WorkerTurnToolStateIdentity,
): Set<WorkerSessionToolOperationWaiter> {
  let byClaim = workerSessionToolOperationWaiters.get(path);
  if (!byClaim) {
    byClaim = new Map();
    workerSessionToolOperationWaiters.set(path, byClaim);
  }
  const key = workerSessionToolOperationWaiterKey(identity);
  let waiters = byClaim.get(key);
  if (!waiters) {
    waiters = new Set();
    byClaim.set(key, waiters);
  }
  return waiters;
}

function signalWorkerSessionToolOperationChange(
  path: string,
  identity: WorkerTurnToolStateIdentity,
): void {
  const byClaim = workerSessionToolOperationWaiters.get(path);
  const key = workerSessionToolOperationWaiterKey(identity);
  const waiters = byClaim?.get(key);
  if (!waiters) {
    return;
  }
  byClaim?.delete(key);
  if (byClaim?.size === 0) {
    workerSessionToolOperationWaiters.delete(path);
  }
  for (const resolve of waiters) {
    resolve();
  }
}

function hasRunningWorkerSessionToolOperations(
  db: DatabaseSync,
  identity: WorkerTurnToolStateIdentity,
): boolean {
  return Boolean(
    executeSqliteQuerySync(
      db,
      query(db)
        .selectFrom("worker_session_tool_operations")
        .select("tool_call_id")
        .where("source_session_id", "=", identity.sessionId)
        .where("source_claim_id", "=", identity.claimId)
        .where("status", "=", "running")
        .limit(1),
    ).rows[0],
  );
}

export function assertNoRunningWorkerSessionToolOperations(
  db: DatabaseSync,
  identity: WorkerTurnToolStateIdentity,
): void {
  if (hasRunningWorkerSessionToolOperations(db, identity)) {
    throw new Error(`Session ${identity.sessionId} has a running worker session operation`);
  }
}

function closeWorkerTurnToolAdmission(
  db: DatabaseSync,
  identity: WorkerTurnToolStateIdentity,
): void {
  executeSqliteQuerySync(
    db,
    query(db)
      .deleteFrom("worker_turn_tool_authorities")
      .where("session_id", "=", identity.sessionId)
      .where("claim_id", "=", identity.claimId),
  );
}

/** Removes authority and replay data in the same transaction that revokes the turn claim. */
export function clearWorkerTurnToolState(
  db: DatabaseSync,
  identity: WorkerTurnToolStateIdentity,
): void {
  closeWorkerTurnToolAdmission(db, identity);
  executeSqliteQuerySync(
    db,
    query(db)
      .deleteFrom("worker_session_tool_operations")
      .where("source_session_id", "=", identity.sessionId)
      .where("source_claim_id", "=", identity.claimId),
  );
}

async function waitForWorkerSessionToolOperations(params: {
  path: string;
  read: PlacementStoreRuntime["read"];
  identity: WorkerTurnToolStateIdentity;
}): Promise<void> {
  while (hasRunningWorkerSessionToolOperations(params.read(), params.identity)) {
    await new Promise<void>((resolve, reject) => {
      const waiters = workerSessionToolOperationWaitersFor(params.path, params.identity);
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        waiters.delete(finish);
        if (waiters.size === 0) {
          const byClaim = workerSessionToolOperationWaiters.get(params.path);
          byClaim?.delete(workerSessionToolOperationWaiterKey(params.identity));
          if (byClaim?.size === 0) {
            workerSessionToolOperationWaiters.delete(params.path);
          }
        }
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      waiters.add(finish);
      // Register first, then reread to close the completion-before-wait race.
      if (!hasRunningWorkerSessionToolOperations(params.read(), params.identity)) {
        finish();
      }
    });
  }
}

export function createPlacementSessionToolOperationOps(runtime: PlacementStoreRuntime) {
  const { instanceId, path, now, read, write } = runtime;
  const currentWorkerClaim = (db: DatabaseSync, claim: WorkerSessionTurnClaim) => {
    const current = find(db, required(claim.sessionId, "session id"));
    return claim.owner.kind === "worker" && current && isCurrentPlacementTurnClaim(current, claim)
      ? current
      : undefined;
  };
  const exactWorkerClaim = (db: DatabaseSync, claim: WorkerSessionTurnClaim): void => {
    if (!currentWorkerClaim(db, claim)) {
      throw new Error(`Session ${claim.sessionId} worker turn authority changed`);
    }
  };
  const hasToolAuthority = (db: DatabaseSync, claim: WorkerSessionTurnClaim, toolName: string) => {
    if (!currentWorkerClaim(db, claim) || claim.owner.kind !== "worker") {
      return false;
    }
    const authority = executeSqliteQuerySync(
      db,
      query(db)
        .selectFrom("worker_turn_tool_authorities")
        .selectAll()
        .where("session_id", "=", claim.sessionId),
    ).rows[0];
    if (
      !authority ||
      authority.environment_id !== claim.owner.environmentId ||
      authority.owner_epoch !== claim.owner.ownerEpoch ||
      authority.placement_generation !== claim.placementGeneration ||
      authority.claim_id !== claim.claimId ||
      authority.run_id !== claim.runId
    ) {
      return false;
    }
    try {
      const names: unknown = JSON.parse(authority.tool_names_json);
      return (
        Array.isArray(names) &&
        names.every((name) => typeof name === "string") &&
        names.includes(toolName)
      );
    } catch {
      return false;
    }
  };
  return {
    authorizeWorkerTurnTools(claim: WorkerSessionTurnClaim, toolNames: readonly string[]): void {
      const normalized = [
        ...new Set(toolNames.map((name) => required(name, "worker tool name"))),
      ].toSorted();
      if (claim.owner.kind !== "worker") {
        throw new Error(`Session ${claim.sessionId} turn is not worker-owned`);
      }
      const owner = claim.owner;
      write((db) => {
        exactWorkerClaim(db, claim);
        executeSqliteQuerySync(
          db,
          query(db)
            .insertInto("worker_turn_tool_authorities")
            .values({
              session_id: claim.sessionId,
              environment_id: owner.environmentId,
              owner_epoch: owner.ownerEpoch,
              placement_generation: claim.placementGeneration,
              claim_id: claim.claimId,
              run_id: claim.runId,
              tool_names_json: JSON.stringify(normalized),
              updated_at_ms: now(),
            })
            .onConflict((conflict) =>
              conflict.column("session_id").doUpdateSet({
                environment_id: owner.environmentId,
                owner_epoch: owner.ownerEpoch,
                placement_generation: claim.placementGeneration,
                claim_id: claim.claimId,
                run_id: claim.runId,
                tool_names_json: JSON.stringify(normalized),
                updated_at_ms: now(),
              }),
            ),
        );
      });
    },

    isWorkerTurnToolAuthorized(claim: WorkerSessionTurnClaim, toolName: string): boolean {
      return hasToolAuthority(read(), claim, toolName);
    },

    async closeWorkerTurnToolState(claim: WorkerSessionTurnClaim): Promise<void> {
      if (claim.owner.kind !== "worker") {
        write((db) => {
          const current = getRequired(db, required(claim.sessionId, "session id"));
          if (!isCurrentPlacementTurnClaim(current, claim)) {
            throw new Error(`Session ${claim.sessionId} local turn authority changed`);
          }
          const identity = { sessionId: claim.sessionId, claimId: claim.claimId };
          assertNoRunningWorkerSessionToolOperations(db, identity);
          clearWorkerTurnToolState(db, identity);
        });
        return;
      }
      const identity = {
        sessionId: claim.sessionId,
        claimId: claim.claimId,
      };
      write((db) => {
        exactWorkerClaim(db, claim);
        // Close admission before provider or workspace teardown. This prevents
        // a late nested call from racing claim release after the worker turn ended.
        closeWorkerTurnToolAdmission(db, identity);
      });
      await waitForWorkerSessionToolOperations({ path, read, identity });
      write((db) => {
        exactWorkerClaim(db, claim);
        assertNoRunningWorkerSessionToolOperations(db, identity);
        clearWorkerTurnToolState(db, identity);
      });
    },

    beginWorkerSessionToolOperation(params: {
      claim: WorkerSessionTurnClaim;
      toolName: "sessions_spawn" | "sessions_send";
      toolCallId: string;
      requestDigest: string;
      childSessionKey?: string;
    }): WorkerSessionToolOperationStart {
      return write((db) => {
        if (!hasToolAuthority(db, params.claim, params.toolName)) {
          return { kind: "unauthorized" };
        }
        const claimId = params.claim.claimId;
        const existing = executeSqliteQuerySync(
          db,
          query(db)
            .selectFrom("worker_session_tool_operations")
            .selectAll()
            .where("source_session_id", "=", params.claim.sessionId)
            .where("source_claim_id", "=", claimId)
            .where("tool_call_id", "=", params.toolCallId),
        ).rows[0];
        if (existing) {
          if (
            existing.tool_name !== params.toolName ||
            existing.request_digest !== params.requestDigest ||
            (params.childSessionKey !== undefined &&
              existing.child_session_key !== params.childSessionKey)
          ) {
            return { kind: "conflict" };
          }
          if (
            (existing.status === "succeeded" || existing.status === "failed") &&
            existing.result_json
          ) {
            return { kind: "completed", resultJson: existing.result_json };
          }
          if (existing.status === "unknown") {
            return { kind: "unknown" };
          }
          if (existing.gateway_instance_id === instanceId) {
            return { kind: "in-progress" };
          }
          // A second store can observe the row in tests and unsupported
          // multi-Gateway embeddings. Observation must not revoke the live
          // executor's fence; exclusive Gateway startup owns crash recovery.
          return { kind: "unknown" };
        }
        const runningCount = executeSqliteQuerySync(
          db,
          query(db)
            .selectFrom("worker_session_tool_operations")
            .select("tool_call_id")
            .where("source_session_id", "=", params.claim.sessionId)
            .where("source_claim_id", "=", claimId)
            .where("status", "=", "running"),
        ).rows.length;
        if (runningCount >= MAX_RUNNING_WORKER_SESSION_TOOL_OPERATIONS) {
          return { kind: "capacity" };
        }
        const timestamp = now();
        const operationSeed = generateSecureToken(32);
        executeSqliteQuerySync(
          db,
          query(db)
            .insertInto("worker_session_tool_operations")
            .values({
              source_session_id: params.claim.sessionId,
              source_claim_id: claimId,
              tool_call_id: params.toolCallId,
              tool_name: params.toolName,
              request_digest: params.requestDigest,
              operation_seed: operationSeed,
              status: "running",
              child_session_key: params.childSessionKey ?? null,
              result_json: null,
              gateway_instance_id: instanceId,
              created_at_ms: timestamp,
              updated_at_ms: timestamp,
            }),
        );
        return {
          kind: "execute",
          operationSeed,
          ...(params.childSessionKey ? { childSessionKey: params.childSessionKey } : {}),
        };
      });
    },

    bindWorkerSessionToolOperationChild(params: {
      sourceSessionId: string;
      sourceClaimId: string;
      toolCallId: string;
      requestDigest: string;
      childSessionKey: string;
    }): boolean {
      return write((db) => {
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_session_tool_operations")
            .set({ child_session_key: params.childSessionKey, updated_at_ms: now() })
            .where("source_session_id", "=", params.sourceSessionId)
            .where("source_claim_id", "=", params.sourceClaimId)
            .where("tool_call_id", "=", params.toolCallId)
            .where("request_digest", "=", params.requestDigest)
            .where("gateway_instance_id", "=", instanceId)
            .where("status", "=", "running")
            .where((expression) =>
              expression.or([
                expression("child_session_key", "is", null),
                expression("child_session_key", "=", params.childSessionKey),
              ]),
            ),
        );
        return result.numAffectedRows === 1n;
      });
    },

    completeWorkerSessionToolOperation(params: {
      sourceSessionId: string;
      sourceClaimId: string;
      toolCallId: string;
      requestDigest: string;
      resultJson: string;
      failed?: boolean;
    }): boolean {
      const completed = write((db) => {
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_session_tool_operations")
            .set({
              status: params.failed ? "failed" : "succeeded",
              result_json: params.resultJson,
              updated_at_ms: now(),
            })
            .where("source_session_id", "=", params.sourceSessionId)
            .where("source_claim_id", "=", params.sourceClaimId)
            .where("tool_call_id", "=", params.toolCallId)
            .where("request_digest", "=", params.requestDigest)
            .where("gateway_instance_id", "=", instanceId)
            .where("status", "=", "running"),
        );
        return result.numAffectedRows === 1n;
      });
      if (completed) {
        signalWorkerSessionToolOperationChange(path, {
          sessionId: params.sourceSessionId,
          claimId: params.sourceClaimId,
        });
      }
      return completed;
    },

    abandonWorkerSessionToolOperation(params: {
      sourceSessionId: string;
      sourceClaimId: string;
      toolCallId: string;
      requestDigest: string;
    }): boolean {
      const abandoned = write((db) => {
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_session_tool_operations")
            .set({ status: "unknown", updated_at_ms: now() })
            .where("source_session_id", "=", params.sourceSessionId)
            .where("source_claim_id", "=", params.sourceClaimId)
            .where("tool_call_id", "=", params.toolCallId)
            .where("request_digest", "=", params.requestDigest)
            .where("gateway_instance_id", "=", instanceId)
            .where("status", "=", "running"),
        );
        return result.numAffectedRows === 1n;
      });
      if (abandoned) {
        signalWorkerSessionToolOperationChange(path, {
          sessionId: params.sourceSessionId,
          claimId: params.sourceClaimId,
        });
      }
      return abandoned;
    },

    recoverWorkerSessionToolOperationsAfterRestart(): number {
      return write((db) => {
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_session_tool_operations")
            .set({ status: "unknown", updated_at_ms: now() })
            .where("status", "=", "running"),
        );
        return Number(result.numAffectedRows);
      });
    },
  };
}
