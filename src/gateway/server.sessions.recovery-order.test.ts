import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  seedSessionTranscript,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import { coordinateWorkerPlacementDispatch } from "./worker-environments/placement-dispatch-coordinator.js";
import type { WorkerPlacementDispatchService } from "./worker-environments/placement-dispatch.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

test.each([false, true])(
  "concurrent cloud recovery waits for its canonical successor and rechecks queued authority (revoked: %s)",
  async (revokeAuthority) => {
    const { storePath } = await createSessionStoreDir();
    const sourceKey = "agent:main:dashboard:concurrent-cloud-recovery";
    const sourceSessionId = "concurrent-cloud-recovery-source";
    await writeSessionStore({
      entries: {
        [sourceKey]: sessionStoreEntry(sourceSessionId, {
          status: "failed",
          abortedLastRun: true,
          mainRestartRecovery: {
            cycleId: "concurrent-recovery-cycle",
            revision: 1,
            chargedAttempts: 3,
            tombstone: { reason: "automatic recovery exhausted" },
          },
        }),
      },
    });
    await seedSessionTranscript({
      agentId: "main",
      sessionId: sourceSessionId,
      sessionKey: sourceKey,
      storePath,
      messages: [{ role: "user", content: "recover the interrupted cloud workspace" }],
    });
    let placement = {
      sessionId: sourceSessionId,
      sessionKey: sourceKey,
      agentId: "main",
      state: "active",
      generation: 2,
      environmentId: "worker-env",
      activeOwnerEpoch: 1,
      turnClaim: null,
    } as WorkerSessionPlacementRecord;
    const reclaimEntered = createDeferredCore();
    const startReclaim = createDeferredCore();
    const reclaimed = createDeferredCore();
    const releaseResult = createDeferredCore();
    let reclaimCalls = 0;
    const service = coordinateWorkerPlacementDispatch(
      {
        reclaim: async (_request, authorize, beforeDrain, serialize) => {
          const first = ++reclaimCalls === 1;
          const result = await serialize!(async () => {
            if (first) {
              reclaimEntered.resolve();
              await startReclaim.promise;
            }
            authorize?.();
            beforeDrain?.();
            placement = {
              ...placement,
              state: "reclaimed",
              generation: placement.generation + 1,
            } as WorkerSessionPlacementRecord;
            return placement as Extract<WorkerSessionPlacementRecord, { state: "reclaimed" }>;
          });
          if (first) {
            reclaimed.resolve();
            await releaseResult.promise;
          }
          return result;
        },
      } as WorkerPlacementDispatchService,
      (_request, run) => run(),
    );
    const context = {
      workerPlacementDispatchService: service,
      workerSessionPlacementService: { getMany: () => new Map([[sourceSessionId, placement]]) },
    };
    type RecoveryPayload = { key: string; sessionId: string };
    const first = directSessionReq<RecoveryPayload>(
      "sessions.recover",
      { key: sourceKey },
      { context },
    );
    await reclaimEntered.promise;
    let authorityActive = true;
    let secondSettled = false;
    const second = directSessionReq<RecoveryPayload>(
      "sessions.recover",
      { key: sourceKey },
      {
        client: {
          connect: { scopes: ["operator.write"] },
          internal: {
            agentRuntimeIdentity: { kind: "agentRuntime", agentId: "main", sessionKey: sourceKey },
          },
        } as never,
        context: {
          ...context,
          validateAgentRuntimeApprovalAuthority: () => authorityActive,
        },
      },
    ).finally(() => {
      secondSettled = true;
    });
    let settledBeforeCommit = false;
    try {
      await nextTurn();
      authorityActive = !revokeAuthority;
      startReclaim.resolve();
      await reclaimed.promise;
      // The placement queue is free, but the winner has not published its successor.
      await nextTurn();
      settledBeforeCommit = secondSettled;
    } finally {
      startReclaim.resolve();
      releaseResult.resolve();
      await Promise.allSettled([first, second]);
    }
    const winner = await first;
    expect(winner.ok, JSON.stringify(winner.error)).toBe(true);
    expect(settledBeforeCommit).toBe(false);
    if (revokeAuthority) {
      expect(await second).toMatchObject({
        ok: false,
        error: { message: "agent runtime authority is no longer active" },
      });
    } else {
      expect(await second).toMatchObject({
        ok: true,
        payload: { key: winner.payload?.key, sessionId: winner.payload?.sessionId },
      });
    }
    expect(loadSessionEntry({ agentId: "main", sessionKey: sourceKey, storePath })).toMatchObject({
      mainRestartRecovery: {
        tombstone: {
          recoveredSessionKey: winner.payload?.key,
          recoveredSessionId: winner.payload?.sessionId,
        },
      },
    });
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: winner.payload!.key, storePath }),
    ).toMatchObject({ sessionId: winner.payload?.sessionId, previousSessionId: sourceSessionId });
  },
);
