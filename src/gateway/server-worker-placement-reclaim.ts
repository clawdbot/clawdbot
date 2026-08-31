import { createAgentRunDirectAbortError } from "../agents/run-termination.js";
import type { ManagedWorktreeService } from "../agents/worktrees/service.js";
import { getRuntimeConfig } from "../config/config.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import {
  closeSessionWorkAdmissions,
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../sessions/session-lifecycle-admission.js";
import type { WorkerPlacementSessionWorkCancellation } from "./server-worker-placement-cancel.js";
import {
  resolveWorkerPlacementSessionTarget,
  WorkerDispatchTargetChangedError,
} from "./server-worker-placement-session-target.js";
import type { WorkerPlacementReclaimBarriers } from "./worker-environments/placement-reclaim-contract.js";
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
  cancelSessionWork: WorkerPlacementSessionWorkCancellation;
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
    const lifecycleIdentities = [sessionKey, target.canonicalKey, ...target.storeKeys, sessionId];
    const cancelAndDrain = async (
      closeWorkAdmissions: (reason: Error) => void,
      assertCurrent: () => void,
      assertCancellationCurrent = assertCurrent,
    ) => {
      const reason = createAgentRunDirectAbortError();
      assertCurrent();
      closeWorkAdmissions(reason);
      await params.cancelSessionWork({
        sessionId,
        sessionKeys: lifecycleIdentities,
        agentId,
        assertCurrent: assertCancellationCurrent,
      });
      assertCurrent();
      const released = await interruptSessionWorkAdmissions({
        reason,
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
      await runExclusiveSessionStoreWrite(target.storePath, async () => {}, { reentrant: true });
    };
    return { sessionRuntime, target, lifecycleIdentities, cancelAndDrain };
  };

  const runReclaimPreparation: WorkerPlacementReclaimBarriers["runReclaimPreparation"] = async ({
    sessionId,
    sessionKey,
    agentId,
    authorize,
    beforeDrain,
    run,
  }) => {
    const { sessionRuntime, target, lifecycleIdentities, cancelAndDrain } =
      await resolveLifecycleContext({ sessionId, sessionKey, agentId });
    const entry = sessionRuntime.resolveCanonicalSessionEntryFromStoreKeys(
      target.store,
      target.storeKeys,
    );
    const revision = entry?.lifecycleRevision ?? null;
    const assertCurrent = () => {
      authorize?.();
      const current = sessionRuntime.resolveGatewaySessionStoreTargetWithStore({
        cfg: getRuntimeConfig(),
        key: sessionKey,
        agentId,
        clone: false,
      });
      const currentEntry = sessionRuntime.resolveCanonicalSessionEntryFromStoreKeys(
        current.store,
        current.storeKeys,
      );
      if (
        current.storePath !== target.storePath ||
        current.canonicalKey !== target.canonicalKey ||
        current.agentId !== target.agentId ||
        currentEntry?.sessionId !== sessionId ||
        (currentEntry.lifecycleRevision ?? null) !== revision
      ) {
        throw new WorkerDispatchTargetChangedError(
          `Session ${sessionKey} changed before cloud worker stop. Retry.`,
        );
      }
    };
    assertCurrent();
    beforeDrain?.();
    const placement = params.placements.get(sessionId);
    if (!placement || placement.state === "local" || placement.state === "reclaimed") {
      return await run(assertCurrent);
    }
    // This lease blocks ingress without a mutex: cancellation recovery must still be able
    // to acquire lifecycle and placement fences before Stop reserves its teardown turn.
    const release = closeSessionWorkAdmissions({
      scope: target.storePath,
      identities: lifecycleIdentities,
      reason: createAgentRunDirectAbortError(),
    });
    try {
      if (
        placement.state === "active" ||
        placement.state === "draining" ||
        placement.state === "failed"
      ) {
        await cancelAndDrain(
          () => {},
          assertCurrent,
          () => {
            assertCurrent();
            const current = params.placements.get(sessionId);
            if (
              current?.generation !== placement.generation ||
              current.state !== placement.state ||
              current.environmentId !== placement.environmentId ||
              current.activeOwnerEpoch !== placement.activeOwnerEpoch
            ) {
              throw new WorkerDispatchTargetChangedError(
                `Session ${sessionKey} cloud worker changed before cancellation. Retry.`,
              );
            }
          },
        );
      }
      assertCurrent();
      return await run(assertCurrent);
    } finally {
      release();
    }
  };

  const runReclaimBarrier: WorkerPlacementReclaimBarriers["runReclaimBarrier"] = async ({
    sessionId,
    sessionKey,
    agentId,
    authorize,
    beforeDrain,
    begin,
    reclaim,
  }) => {
    const { sessionRuntime, target, lifecycleIdentities, cancelAndDrain } =
      await resolveLifecycleContext({
        sessionId,
        sessionKey,
        agentId,
      });
    let worktreePath: string | undefined;
    let reclaimedPlacement: Awaited<ReturnType<typeof reclaim>> | undefined;
    await runExclusiveSessionLifecycleMutation({
      scope: target.storePath,
      identities: lifecycleIdentities,
      prepare: async (lifecycle) => {
        beforeDrain?.();
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
        if (
          placement?.state !== "active" &&
          placement?.state !== "draining" &&
          placement?.state !== "reclaimed"
        ) {
          throw new Error(
            `Session ${sessionKey} has active work; wait before stopping its cloud worker`,
          );
        }
        worktreePath = worktree.path;
        const assertCurrent = () => {
          authorize?.();
          resolveWorkerPlacementSessionTarget({
            sessionRuntime,
            config: getRuntimeConfig(),
            sessionId,
            sessionKey,
            agentId,
            expectedTarget: target,
            errorMessage: `Session ${sessionKey} changed before cloud worker stop. Retry.`,
          });
        };
        await cancelAndDrain(lifecycle.closeWorkAdmissions, assertCurrent);
      },
      run: async () => {
        if (!worktreePath) {
          throw new Error(`Session ${sessionKey} cloud worker stop barrier did not prepare`);
        }
        // Sharing mutations use this lifecycle fence too. Reauthorize after every wait and
        // immediately before drain so revoked callers cannot commit stale placement authority.
        authorize?.();
        // Eligibility ends at this operation's drain, unlike caller authority during teardown.
        beforeDrain?.();
        const placement = begin();
        reclaimedPlacement = await reclaim(worktreePath, placement, authorize);
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
      const { sessionRuntime, target, lifecycleIdentities, cancelAndDrain } =
        await resolveLifecycleContext({
          sessionId,
          sessionKey,
          agentId,
        });
      const assertCurrent = () => {
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
      };
      let reclaimedPlacement: Awaited<ReturnType<typeof reclaim>> | undefined;
      await runExclusiveSessionLifecycleMutation({
        scope: target.storePath,
        identities: lifecycleIdentities,
        prepare: async (lifecycle) => {
          assertCurrent();
          // A preceding failed cleanup may already have returned this placement to local.
          // Its idempotent result must not cancel work admitted after that completed Stop.
          if (params.placements.get(sessionId)?.state === "failed") {
            await cancelAndDrain(lifecycle.closeWorkAdmissions, assertCurrent);
          }
        },
        run: async () => {
          assertCurrent();
          reclaimedPlacement = await reclaim(authorize);
        },
      });
      if (!reclaimedPlacement) {
        throw new Error(`Session ${sessionKey} failed cloud worker cleanup did not complete`);
      }
      return reclaimedPlacement;
    };

  return { runReclaimPreparation, runReclaimBarrier, runFailedReclaimBarrier };
}
