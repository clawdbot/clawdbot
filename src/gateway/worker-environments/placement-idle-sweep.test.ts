import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerPlacementIdleSweep } from "./placement-idle-sweep.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("worker placement idle suspension", () => {
  let nowMs: number;
  let placements: ReturnType<typeof createWorkerSessionPlacementStore>;

  beforeEach(() => {
    nowMs = 1_000;
    const root = tempDirs.make("openclaw-worker-idle-sweep-");
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placements = createWorkerSessionPlacementStore({ database, now: () => nowMs });
  });

  afterEach(() => closeOpenClawStateDatabaseForTest());

  function createIdleFixture(
    options: {
      suspendAfter?: string | null;
      destroyFails?: boolean;
      reclaim?: Parameters<typeof createWorkerPlacementIdleSweep>[0]["dispatch"]["reclaim"];
      isPlacementOperationInFlight?: (sessionId: string) => boolean;
      getSessionWorkAdmissionCheck?: (identity: {
        sessionId: string;
        sessionKey: string;
        agentId: string;
      }) => Promise<() => boolean>;
    } = {},
  ) {
    const harness = createHarness(placements, {
      reconcileChanged: false,
      reconcileCommitsManifest: false,
      destroyFails: options.destroyFails,
    });
    const suspendAfter = options.suspendAfter === undefined ? "1m" : options.suspendAfter;
    const info = vi.fn();
    const warn = vi.fn();
    const isPlacementOperationInFlight = vi.fn(
      (sessionId: string) => options.isPlacementOperationInFlight?.(sessionId) ?? false,
    );
    const idleSweep = createWorkerPlacementIdleSweep({
      placements,
      environments: harness.environments,
      dispatch: { reclaim: options.reclaim ?? harness.service.reclaim },
      getConfig: () => ({
        cloudWorkers: {
          profiles: {
            [REQUEST.profileId]: {
              provider: "fake",
              ...(suspendAfter === null ? {} : { suspendAfter }),
            },
          },
        },
      }),
      isPlacementOperationInFlight,
      ...(options.getSessionWorkAdmissionCheck
        ? { getSessionWorkAdmissionCheck: options.getSessionWorkAdmissionCheck }
        : {}),
      info,
      warn,
      now: () => nowMs,
    });
    return { harness, idleSweep, info, warn, isPlacementOperationInFlight };
  }

  function claimWorkerTurn(claimId = "busy-worker-claim") {
    const active = placements.get(REQUEST.sessionId);
    if (active?.state !== "active") {
      throw new Error("expected an active worker placement");
    }
    return placements.claimTurn({
      ...REQUEST,
      claimId,
      runId: `run-${claimId}`,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
  }

  it("suspends a never-run worker after its activation through the real reclaim teardown", async () => {
    const { harness, idleSweep, info, warn } = createIdleFixture();
    const active = await harness.service.dispatch(REQUEST);

    nowMs += 59_999;
    await idleSweep.sweep();
    expect(placements.get(REQUEST.sessionId)?.state).toBe("active");
    expect(harness.environments.destroy).not.toHaveBeenCalled();

    nowMs += 1;
    await idleSweep.sweep();

    expect(placements.get(REQUEST.sessionId)).toMatchObject({
      state: "reclaimed",
      turnClaim: null,
    });
    expect(harness.environments.destroy).toHaveBeenCalledExactlyOnceWith(active.environmentId);
    expect(harness.log).toEqual(
      expect.arrayContaining([
        "placement:draining",
        "workspace:reconcile",
        "teardown:destroy",
        "placement:reclaimed",
      ]),
    );
    expect(info).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(expect.stringContaining(REQUEST.sessionKey));
    expect(warn).not.toHaveBeenCalled();
  });

  it("starts the idle clock at the latest authoritative turn-claim release", async () => {
    const { harness, idleSweep } = createIdleFixture();
    await harness.service.dispatch(REQUEST);

    nowMs += 50_000;
    const claim = claimWorkerTurn("recent-turn");
    nowMs += 5_000;
    placements.releaseTurn(claim);

    nowMs += 59_999;
    await idleSweep.sweep();
    expect(placements.get(REQUEST.sessionId)?.state).toBe("active");

    nowMs += 1;
    await idleSweep.sweep();
    expect(placements.get(REQUEST.sessionId)?.state).toBe("reclaimed");
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it.each(["dispatch", "move"] as const)(
    "does not suspend while the real coordinator owns an in-flight %s",
    async (kind) => {
      const { harness, idleSweep, info, warn } = createIdleFixture({
        isPlacementOperationInFlight: (sessionId) =>
          coordinated.isPlacementOperationInFlight(sessionId),
      });
      const active = await harness.service.dispatch(REQUEST);
      const operationStarted = createDeferredCore();
      const releaseOperation = createDeferredCore();
      const blockedOperation = async () => {
        operationStarted.resolve();
        await releaseOperation.promise;
        return active;
      };
      const coordinated = coordinateWorkerPlacementDispatch(
        {
          ...harness.service,
          ...(kind === "dispatch" ? { dispatch: blockedOperation } : { move: blockedOperation }),
        },
        (_request, run) => run(),
      );
      const inFlight =
        kind === "dispatch"
          ? coordinated.dispatch(REQUEST)
          : coordinated.move({
              sessionId: active.sessionId,
              sessionKey: active.sessionKey,
              agentId: active.agentId,
              source: {
                generation: active.generation,
                environmentId: active.environmentId,
                ownerEpoch: active.activeOwnerEpoch,
              },
              target: { kind: "gateway" },
            });

      try {
        await operationStarted.promise;
        nowMs += 60_000;
        expect(coordinated.isPlacementOperationInFlight(active.sessionId)).toBe(true);

        await idleSweep.sweep();

        expect(placements.get(active.sessionId)?.state).toBe("active");
        expect(harness.environments.destroy).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
      } finally {
        releaseOperation.resolve();
        await inFlight;
      }
      expect(coordinated.isPlacementOperationInFlight(active.sessionId)).toBe(false);
    },
  );

  it.each([
    { reason: "an active worker turn", kind: "worker-claim" },
    { reason: "an active local turn", kind: "local-claim" },
    { reason: "an admitted turn before its worker claim exists", kind: "admitted-turn" },
    { reason: "queued session work before worker admission", kind: "queued-turn" },
    { reason: "a durable pending result after its claim was revoked", kind: "pending-result" },
    { reason: "a durable workspace reconciliation journal", kind: "reconciling-result" },
    { reason: "a profile without suspendAfter", kind: "no-suspend-after" },
    { reason: "a placement still provisioning", kind: "provisioning" },
    { reason: "a placement already draining", kind: "draining" },
  ] as const)("does not suspend when blocked by $reason", async ({ kind }) => {
    const getSessionWorkAdmissionCheck =
      kind === "admitted-turn" || kind === "queued-turn"
        ? vi.fn(async () => () => true)
        : undefined;
    const { harness, idleSweep, info, warn } = createIdleFixture({
      ...(kind === "no-suspend-after" ? { suspendAfter: null } : {}),
      ...(getSessionWorkAdmissionCheck ? { getSessionWorkAdmissionCheck } : {}),
    });

    if (kind === "provisioning") {
      harness.placements.seedProvisioning();
    } else {
      const executionMode =
        kind === "local-claim" || kind === "pending-result" ? "remote-exec" : "worker-turn";
      const active = await harness.service.dispatch({ ...REQUEST, executionMode });
      if (kind === "worker-claim") {
        claimWorkerTurn();
      } else if (kind === "local-claim" || kind === "pending-result") {
        const claim = placements.claimTurn({
          ...REQUEST,
          claimId: "busy-local-claim",
          runId: "busy-local-run",
          owner: {
            kind: "local",
            environmentId: active.environmentId,
            ownerEpoch: active.activeOwnerEpoch,
          },
        });
        if (kind === "pending-result") {
          placements.markWorkspaceResultPending(claim);
          placements.clearLocalTurnClaimsAfterRestart();
          expect(placements.get(REQUEST.sessionId)?.turnClaim).toBeNull();
          expect(placements.listPendingWorkspaceResults()).toHaveLength(1);
        }
      } else if (kind === "reconciling-result") {
        const basePack = Buffer.from("idle workspace journal");
        placements.beginWorkspaceReconciliation(
          {
            sessionId: active.sessionId,
            environmentId: active.environmentId,
            ownerEpoch: active.activeOwnerEpoch,
            placementGeneration: active.generation,
          },
          {
            version: 1,
            temporaryNonce: "a".repeat(32),
            baseManifestRef: active.workspaceBaseManifestRef,
            currentManifestRef: `sha256:${"c".repeat(64)}`,
            baseEntries: [],
            appliedEntries: [],
            baseTree: "f".repeat(40),
            basePackSha256: createHash("sha256").update(basePack).digest("hex"),
            basePack,
          },
        );
        expect(placements.get(REQUEST.sessionId)?.turnClaim).toBeNull();
      } else if (kind === "draining") {
        placements.startDrain({
          sessionId: active.sessionId,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
          expectedGeneration: active.generation,
        });
      }
    }

    nowMs += 120_000;
    const expectedState = placements.get(REQUEST.sessionId)?.state;
    await idleSweep.sweep();

    expect(placements.get(REQUEST.sessionId)?.state).toBe(expectedState);
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    if (getSessionWorkAdmissionCheck) {
      expect(placements.get(REQUEST.sessionId)?.turnClaim).toBeNull();
      expect(getSessionWorkAdmissionCheck).toHaveBeenCalledExactlyOnceWith({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      });
    }
  });

  it("abandons suspension silently when session work is admitted before reclaim begins", async () => {
    const hasSessionWork = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const getSessionWorkAdmissionCheck = vi.fn(async () => hasSessionWork);
    const { harness, idleSweep, info, warn } = createIdleFixture({
      getSessionWorkAdmissionCheck,
    });
    await harness.service.dispatch(REQUEST);
    nowMs += 60_000;

    await expect(idleSweep.sweep()).resolves.toBeUndefined();

    expect(hasSessionWork).toHaveBeenCalledTimes(2);
    expect(placements.get(REQUEST.sessionId)).toMatchObject({ state: "active", turnClaim: null });
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps a recently used worker when automatic reclaim waited behind another dispatch", async () => {
    const dispatchStarted = createDeferredCore();
    const releaseDispatch = createDeferredCore();
    const reclaimQueued = createDeferredCore();
    const { harness, idleSweep, info, warn } = createIdleFixture({
      reclaim: (request, authorize, beforeDrain) => {
        const pending = coordinated.reclaim(request, authorize, beforeDrain);
        reclaimQueued.resolve();
        return pending;
      },
      isPlacementOperationInFlight: (sessionId) =>
        coordinated.isPlacementOperationInFlight(sessionId),
      getSessionWorkAdmissionCheck: async () => () => false,
    });
    const active = await harness.service.dispatch(REQUEST);
    const coordinated = coordinateWorkerPlacementDispatch(
      {
        ...harness.service,
        dispatch: async () => {
          dispatchStarted.resolve();
          await releaseDispatch.promise;
          return active;
        },
      },
      (_request, run) => run(),
    );
    const unrelatedDispatch = coordinated.dispatch({
      ...REQUEST,
      sessionId: "another-session",
      sessionKey: "agent:main:another-session",
    });
    let sweeping: Promise<void> | undefined;
    try {
      await dispatchStarted.promise;
      nowMs += 60_000;
      sweeping = idleSweep.sweep();
      await reclaimQueued.promise;

      const claim = claimWorkerTurn("turn-during-idle-reclaim-wait");
      nowMs += 1_000;
      placements.releaseTurn(claim);
      releaseDispatch.resolve();
      await Promise.all([unrelatedDispatch, sweeping]);

      expect(placements.get(REQUEST.sessionId)).toMatchObject({
        state: "active",
        turnClaim: null,
        updatedAtMs: nowMs,
      });
      expect(harness.environments.destroy).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();

      nowMs += 60_000;
      await idleSweep.sweep();
      expect(placements.get(REQUEST.sessionId)?.state).toBe("reclaimed");
      expect(harness.environments.destroy).toHaveBeenCalledOnce();
    } finally {
      releaseDispatch.resolve();
      await Promise.allSettled([unrelatedDispatch, sweeping]);
    }
  });

  it("finishes its owned drain without rechecking idle eligibility during teardown", async () => {
    let hasSessionWork = false;
    const { harness, idleSweep, info, warn } = createIdleFixture({
      getSessionWorkAdmissionCheck: async () => () => hasSessionWork,
    });
    await harness.service.dispatch(REQUEST);
    const startTunnel = vi.mocked(harness.environments.startTunnel).getMockImplementation();
    if (!startTunnel) {
      throw new Error("expected the fixture tunnel implementation");
    }
    vi.mocked(harness.environments.startTunnel).mockImplementationOnce(async (...args) => {
      expect(placements.get(REQUEST.sessionId)?.state).toBe("draining");
      hasSessionWork = true;
      return await startTunnel(...args);
    });
    nowMs += 60_000;

    await idleSweep.sweep();

    expect(placements.get(REQUEST.sessionId)?.state).toBe("reclaimed");
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs a failed reclaim once without immediately retrying provider teardown", async () => {
    const { harness, idleSweep, info, warn } = createIdleFixture({ destroyFails: true });
    await harness.service.dispatch(REQUEST);
    nowMs += 60_000;

    await expect(idleSweep.sweep()).resolves.toBeUndefined();

    expect(harness.environments.destroy).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(info).not.toHaveBeenCalled();
  });
});
