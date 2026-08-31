import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createAgentRunDirectAbortError } from "../agents/run-termination.js";
import type { ManagedWorktreeService } from "../agents/worktrees/service.js";
import { getRuntimeConfig } from "../config/config.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import { withTimeout } from "../infra/fs-safe.js";
import {
  closeSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
  startSessionWorkAdmissionInterruption,
} from "../sessions/session-lifecycle-admission.js";
import type { WorkerPlacementSessionWorkCancellation } from "./server-worker-placement-cancel.js";
import {
  resolveWorkerPlacementSessionTarget,
  WorkerDispatchTargetChangedError,
} from "./server-worker-placement-session-target.js";
import {
  matchesWorkerPlacementTarget,
  type WorkerPlacementReclaimBarriers,
} from "./worker-environments/placement-reclaim-contract.js";
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
      pendingSettlement?: Promise<unknown>,
    ) => {
      const reason = createAgentRunDirectAbortError();
      assertCurrent();
      closeWorkAdmissions(reason);
      let released: Promise<void> | undefined;
      let interruptionStarted = false;
      let interruptionError: Error | undefined;
      const interrupt = () => {
        if (interruptionStarted) {
          return;
        }
        interruptionStarted = true;
        try {
          assertCurrent();
          released = startSessionWorkAdmissionInterruption({
            reason,
            scope: target.storePath,
            identities: lifecycleIdentities,
          }).released;
        } catch (error) {
          // The synchronous abort producer must still persist its terminal/partial outcome.
          interruptionError = toErrorObject(error, "Session work interruption failed");
        }
      };
      const settled = pendingSettlement?.then(
        () => undefined,
        () => undefined,
      );
      try {
        await params.cancelSessionWork({
          sessionId,
          sessionKeys: lifecycleIdentities,
          agentId,
          assertCurrent: assertCancellationCurrent,
          // A queued dispatch can coexist with local chat before any placement exists.
          // Interrupt only after canonical abort snapshots partials and retires approvals.
          ...(pendingSettlement ? { onCancellationStarted: interrupt } : {}),
        });
        interrupt();
        // Caller timeouts do not settle provider work. Keep this exact operation outside
        // the native-turn deadline, then bound the remaining admission/turn drains.
        await settled;
        if (interruptionError !== undefined) {
          throw interruptionError;
        }
        assertCurrent();
        await withTimeout(
          released!,
          SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
          "session work admission drain",
        );
      } catch (error) {
        if (interruptionStarted) {
          await settled;
        }
        throw error;
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
    pendingOperations,
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
    const pending = pendingOperations?.isCurrent() ? pendingOperations : undefined;
    const dispatch = pending?.hasPendingDispatch() === true;
    if (
      !dispatch &&
      (!placement || placement.state === "local" || placement.state === "reclaimed")
    ) {
      // A predecessor Stop is an ordering dependency, not authority to cancel local chat.
      await pending?.settled;
      assertCurrent();
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
      const cancelRunningWork =
        placement?.state === "active" ||
        placement?.state === "draining" ||
        placement?.state === "failed";
      if (dispatch || cancelRunningWork) {
        await cancelAndDrain(
          () => {},
          assertCurrent,
          () => {
            assertCurrent();
            const current = params.placements.get(sessionId);
            const captured = pending?.currentPlacement();
            // A predecessor can retain an older phase after its captured dispatch completes.
            // Keep the newest recorded fact within the lifecycle just revalidated above.
            const expected =
              captured && (!placement || captured.generation > placement.generation)
                ? captured
                : placement;
            if ((expected || pending) && !matchesWorkerPlacementTarget(current, expected)) {
              throw new WorkerDispatchTargetChangedError(
                `Session ${sessionKey} cloud worker changed before cancellation. Retry.`,
              );
            }
          },
          pending?.settled,
        );
      } else {
        await pending?.settled;
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
