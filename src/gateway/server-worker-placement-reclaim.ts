import type { ManagedWorktreeService } from "../agents/worktrees/service.js";
import { getRuntimeConfig } from "../config/config.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import {
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../sessions/session-lifecycle-admission.js";
import {
  resolveWorkerPlacementSessionTarget,
  WorkerDispatchTargetChangedError,
} from "./server-worker-placement-session-target.js";
import type { WorkerPlacementReclaimBarriers } from "./worker-environments/placement-dispatch.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type { WorkerPlacementReclaimRequest } from "./worker-environments/service-contract.js";

type SessionUtilsRuntime = typeof import("./session-utils.js");
export type WorkerPlacementSessionRuntime = {
  managedWorktrees: Pick<ManagedWorktreeService, "findLiveByOwner">;
  resolveCanonicalSessionEntryFromStoreKeys: SessionUtilsRuntime["resolveCanonicalSessionEntryFromStoreKeys"];
  resolveGatewaySessionStoreTargetWithStore: SessionUtilsRuntime["resolveGatewaySessionStoreTargetWithStore"];
};

type WorkerPlacementReclaimBarrierParams = {
  placements: Pick<WorkerSessionPlacementStore, "get" | "waitForTurnClaimRelease">;
  loadSessionRuntime: () => Promise<WorkerPlacementSessionRuntime>;
  revokeSessionAuthority: (request: { sessionId: string; sessionKeys: readonly string[] }) => void;
};

export function createGatewayWorkerPlacementReclaimBarriers(
  params: WorkerPlacementReclaimBarrierParams,
): WorkerPlacementReclaimBarriers {
  const resolveLifecycleContext = async ({
    sessionId,
    sessionKey,
    agentId,
  }: WorkerPlacementReclaimRequest) => {
    const sessionRuntime = await params.loadSessionRuntime();
    const target = sessionRuntime.resolveGatewaySessionStoreTargetWithStore({
      cfg: getRuntimeConfig(),
      key: sessionKey,
      agentId,
      clone: false,
    });
    return {
      sessionRuntime,
      target,
      lifecycleIdentities: [sessionKey, target.canonicalKey, ...target.storeKeys, sessionId],
    };
  };

  const runReclaimBarrier: WorkerPlacementReclaimBarriers["runReclaimBarrier"] = async ({
    sessionId,
    sessionKey,
    agentId,
    authorize,
    begin,
    reclaim,
  }) => {
    const { sessionRuntime, target, lifecycleIdentities } = await resolveLifecycleContext({
      sessionId,
      sessionKey,
      agentId,
    });
    let worktreePath: string | undefined;
    let reclaimedPlacement: Awaited<ReturnType<typeof reclaim>> | undefined;
    await runExclusiveSessionLifecycleMutation({
      scope: target.storePath,
      identities: lifecycleIdentities,
      prepare: async () => {
        const { worktree } = resolveWorkerPlacementSessionTarget({
          sessionRuntime,
          config: getRuntimeConfig(),
          sessionId,
          sessionKey,
          agentId,
          expectedTarget: target,
          errorMessage: `Session ${sessionKey} changed before cloud worker stop. Retry.`,
        });
        const placement = params.placements.get(sessionId);
        if (placement?.state !== "active" && placement?.state !== "draining") {
          throw new Error(
            `Session ${sessionKey} has active work; wait before stopping its cloud worker`,
          );
        }
        worktreePath = worktree.path;
        const released = await interruptSessionWorkAdmissions({
          scope: target.storePath,
          identities: lifecycleIdentities,
          timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
        });
        if (!released) {
          throw new Error(`Session ${sessionKey} is still active; cloud worker stop cancelled`);
        }
        await params.placements.waitForTurnClaimRelease(sessionId, {
          timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
        });
        await runExclusiveSessionStoreWrite(target.storePath, async () => {}, {
          reentrant: true,
        });
      },
      run: async () => {
        if (!worktreePath) {
          throw new Error(`Session ${sessionKey} cloud worker stop barrier did not prepare`);
        }
        // Sharing mutations use this lifecycle fence too. Reauthorize after every wait and
        // immediately before drain so revoked callers cannot commit stale placement authority.
        authorize?.();
        const drainingPlacement = begin();
        reclaimedPlacement = await reclaim(worktreePath, drainingPlacement);
        params.revokeSessionAuthority({ sessionId, sessionKeys: lifecycleIdentities });
      },
    });
    if (!reclaimedPlacement) {
      throw new Error(`Session ${sessionKey} cloud worker stop barrier did not complete`);
    }
    return reclaimedPlacement;
  };

  const runFailedReclaimBarrier: WorkerPlacementReclaimBarriers["runFailedReclaimBarrier"] =
    async ({ sessionId, sessionKey, agentId, authorize, reclaim }) => {
      const { sessionRuntime, target, lifecycleIdentities } = await resolveLifecycleContext({
        sessionId,
        sessionKey,
        agentId,
      });
      let reclaimedPlacement: Awaited<ReturnType<typeof reclaim>> | undefined;
      await runExclusiveSessionLifecycleMutation({
        scope: target.storePath,
        identities: lifecycleIdentities,
        run: async () => {
          const currentTarget = sessionRuntime.resolveGatewaySessionStoreTargetWithStore({
            cfg: getRuntimeConfig(),
            key: sessionKey,
            agentId,
            clone: false,
          });
          const currentEntry = sessionRuntime.resolveCanonicalSessionEntryFromStoreKeys(
            currentTarget.store,
            currentTarget.storeKeys,
          );
          if (
            currentTarget.storePath !== target.storePath ||
            currentTarget.canonicalKey !== target.canonicalKey ||
            currentTarget.agentId !== target.agentId ||
            currentEntry?.sessionId !== sessionId
          ) {
            throw new WorkerDispatchTargetChangedError(
              `Session ${sessionKey} changed before failed cloud worker cleanup. Retry.`,
            );
          }
          // Failed teardown is still a session mutation: reauthorize inside the shared lifecycle
          // fence before provider cleanup or the failed-to-local transition becomes durable.
          authorize?.();
          reclaimedPlacement = await reclaim();
        },
      });
      if (!reclaimedPlacement) {
        throw new Error(`Session ${sessionKey} failed cloud worker cleanup did not complete`);
      }
      return reclaimedPlacement;
    };

  return { runReclaimBarrier, runFailedReclaimBarrier };
}
