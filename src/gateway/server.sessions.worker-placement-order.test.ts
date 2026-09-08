import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, test } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { createGatewayWorkerPlacementMoveBarrier } from "./server-worker-placement-move-barrier.js";
import { loadSessionEntry } from "./session-utils.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  seedSessionTranscript,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import { coordinateWorkerPlacementDispatch } from "./worker-environments/placement-dispatch-coordinator.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-store.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

const unexpectedPlacementOperation = async (): Promise<never> => {
  throw new Error("Unexpected placement operation in lifecycle ordering test");
};

test.each(["delete", "archive", "recover"] as const)(
  "%s lets an earlier move acquire its session fence before reclaim",
  async (action) => {
    const { storePath } = await createSessionStoreDir();
    const sessionId = `lifecycle-order-${action}`;
    const sessionKey = `agent:main:${sessionId}`;
    await writeSessionStore({
      entries: {
        [sessionKey]: sessionStoreEntry(sessionId, {
          worktree: { id: "order-worktree", branch: "order-branch", repoRoot: "/fixture/repo" },
          lifecycleRevision: "original-lifecycle",
          ...(action === "recover"
            ? {
                status: "failed" as const,
                abortedLastRun: true,
                mainRestartRecovery: {
                  cycleId: "order-cycle",
                  revision: 1,
                  chargedAttempts: 3,
                  tombstone: { reason: "automatic recovery exhausted" },
                },
              }
            : {}),
        }),
      },
    });
    if (action === "recover") {
      await seedSessionTranscript({
        agentId: "main",
        sessionId,
        sessionKey,
        storePath,
        messages: [{ role: "user", content: "recover this session" }],
      });
    }
    let placement = {
      sessionId,
      sessionKey,
      agentId: "main",
      state: "active",
      generation: 4,
      environmentId: "order-environment",
      activeOwnerEpoch: 2,
      turnClaim: null,
    } as WorkerSessionPlacementRecord;
    const moveLoading = createDeferredCore();
    const releaseMove = createDeferredCore();
    const reclaimEntered = createDeferredCore();
    const cleanupBlockedReclaim = createDeferredCore<never>();
    let moveAcquired = false;
    let serializedReclaim: Promise<unknown> | undefined;
    const moveBarrier = createGatewayWorkerPlacementMoveBarrier({
      placements: { waitForTurnClaimRelease: async () => {} },
      loadSessionRuntime: async () => {
        moveLoading.resolve();
        await releaseMove.promise;
        return {
          managedWorktrees: {
            findLiveByOwner: () => ({
              id: "order-worktree",
              ownerId: sessionKey,
              path: "/fixture/worktree",
            }),
          },
          resolveGatewaySessionStoreTargetWithStore: () => ({
            storePath,
            canonicalKey: sessionKey,
            storeKeys: [sessionKey],
            agentId: "main",
            store: { [sessionKey]: loadSessionEntry(sessionKey).entry! },
          }),
          resolveCanonicalSessionEntryFromStoreKeys: () => loadSessionEntry(sessionKey).entry,
        } as never;
      },
      revokeSessionAuthority: () => {},
    });
    const service = coordinateWorkerPlacementDispatch(
      {
        dispatch: unexpectedPlacementOperation,
        forceDestroyEnvironment: unexpectedPlacementOperation,
        reconcile: unexpectedPlacementOperation,
        reconcileActive: unexpectedPlacementOperation,
        resumeProvisioning: unexpectedPlacementOperation,
        move: async () => {
          await moveBarrier({
            sessionId,
            sessionKey,
            agentId: "main",
            sourceDisposition: "reconcile",
            begin: async () => {
              moveAcquired = true;
              throw new Error("move preflight rejected");
            },
          });
          throw new Error("test Move preflight unexpectedly completed");
        },
        reclaim: async (_request, authorize, beforeDrain, serialize) => {
          reclaimEntered.resolve();
          const reclaim = serialize!(async () => {
            authorize?.();
            beforeDrain?.();
            placement = {
              ...placement,
              state: "reclaimed",
              generation: 7,
            } as WorkerSessionPlacementRecord;
            return placement as Extract<WorkerSessionPlacementRecord, { state: "reclaimed" }>;
          });
          serializedReclaim = reclaim;
          return await Promise.race([reclaim, cleanupBlockedReclaim.promise]);
        },
      },
      (_request, run) => run(),
    );
    const moving = service
      .move({
        sessionId,
        sessionKey,
        agentId: "main",
        source: { generation: 4, environmentId: "order-environment", ownerEpoch: 2 },
        target: { kind: "gateway" },
      })
      .catch((error: unknown) => error);
    await moveLoading.promise;
    const lifecycle = directSessionReq(
      action === "archive" ? "sessions.patch" : `sessions.${action}`,
      action === "archive"
        ? {
            key: sessionKey,
            archived: true,
            expectedSessionId: sessionId,
            expectedLifecycleRevision: "original-lifecycle",
          }
        : { key: sessionKey },
      {
        context: {
          workerPlacementDispatchService: service,
          workerSessionPlacementService: {
            getMany: () => new Map([[sessionId, placement]]),
            retireSessionPlacement: () => {},
          },
        },
      },
    );
    let acquiredBeforeCleanup = false;
    try {
      await Promise.race([
        reclaimEntered.promise,
        lifecycle.then((result) => {
          throw new Error(`Lifecycle returned before reclaim: ${JSON.stringify(result)}`);
        }),
      ]);
      releaseMove.resolve();
      await nextTurn();
      acquiredBeforeCleanup = moveAcquired;
    } finally {
      // Unwind the baseline's real queues before asserting the ordering failure.
      releaseMove.resolve();
      cleanupBlockedReclaim.reject(new Error("test released blocked reclaim"));
      await Promise.allSettled([moving, lifecycle, cleanupBlockedReclaim.promise]);
      await serializedReclaim?.catch(() => {});
    }
    expect(acquiredBeforeCleanup).toBe(true);
    expect(await moving).toMatchObject({ message: "move preflight rejected" });
    const result = await lifecycle;
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    const entry = loadSessionEntry(sessionKey).entry;
    if (action === "delete") {
      expect(entry).toBeUndefined();
    } else {
      expect(entry?.archivedAt).toEqual(expect.any(Number));
      if (action === "recover") {
        expect(entry).toMatchObject({
          mainRestartRecovery: { tombstone: { recoveredSessionKey: expect.any(String) } },
        });
      }
    }
  },
);
