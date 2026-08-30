import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { clearAgentRunContext } from "../infra/agent-run-registry.js";
import { runExclusiveSessionLifecycleMutation } from "../sessions/session-lifecycle-admission.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { pendingChatSendDedupeKey } from "./server-shared.js";
import { cancelGatewayWorkerSessionWork } from "./server-worker-placement-cancel.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "./server-worker-placement-reclaim.js";
import {
  admitWorkerStopChat,
  createWorkerStopChatContext,
} from "./server-worker-placement.test-harness.js";
import { coordinateWorkerPlacementDispatch } from "./worker-environments/placement-dispatch-coordinator.js";
import { REQUEST } from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "./worker-environments/placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { workerWorkspaceResultStaging } from "./worker-environments/workspace-result-staging.js";

const lookup = vi.hoisted(() => ({
  value: undefined as ReturnType<typeof import("./session-utils.js").loadSessionEntry> | undefined,
}));
vi.mock("./session-utils.js", () => ({ loadSessionEntry: () => lookup.value }));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  getRuntimeConfig: () => ({}),
}));
const roots: string[] = [];
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  lookup.value = undefined;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function scenario(
  name: string,
  {
    destroyFailure = false,
    beforeStop = false,
    staged = false,
    failedRetry = false,
    blockedInspection = false,
    cancellationNeedsRecovery = false,
    pendingDispatch = false,
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worker-stop-"));
  roots.push(root);
  const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  const placements = createWorkerSessionPlacementStore({ database, now: () => 1000 });
  const storePath = path.join(root, "sessions.sqlite");
  const worktreePath = path.join(root, "workspace");
  await fs.mkdir(worktreePath);
  const entry = {
    sessionId: REQUEST.sessionId,
    worktree: { id: "task-worktree", branch: "test", repoRoot: worktreePath },
    updatedAt: Date.now(),
  };
  const target = {
    storePath,
    canonicalKey: REQUEST.sessionKey,
    storeKeys: [REQUEST.sessionKey],
    agentId: REQUEST.agentId,
    store: { [REQUEST.sessionKey]: entry },
  };
  lookup.value = { ...target, cfg: {}, entry, legacyKey: undefined };
  const barrierEntered = createDeferred();
  const releaseBarrier = createDeferred();
  const context = createWorkerStopChatContext();
  const revocations: unknown[] = [];
  const barriers = createGatewayWorkerPlacementReclaimBarriers({
    placements,
    loadSessionRuntime: async () =>
      ({
        managedWorktrees: {
          findLiveByOwner: () =>
            failedRetry
              ? undefined
              : {
                  id: "task-worktree",
                  ownerId: REQUEST.sessionKey,
                  path: worktreePath,
                },
        },
        resolveGatewaySessionStoreTargetWithStore: () => target,
        resolveCanonicalSessionEntryFromStoreKeys: () => entry,
      }) as never,
    cancelSessionWork: (request) => cancelGatewayWorkerSessionWork(context, request),
    revokeSessionAuthority: (request) => {
      revocations.push(request);
    },
  });
  let reconciliations = 0;
  const harness = createHarness(placements, {
    workspacePath: worktreePath,
    ...(failedRetry ? { failAt: "sync" as const } : {}),
    runReclaimPreparation: barriers.runReclaimPreparation,
    runReclaimBarrier: barriers.runReclaimBarrier,
    runFailedReclaimBarrier: barriers.runFailedReclaimBarrier,
    ...(destroyFailure
      ? { destroyFailureCount: 1, destroyFailureState: "destroying" as const }
      : {}),
    afterReconcile: async () => {
      if (++reconciliations === 1 && !failedRetry) {
        barrierEntered.resolve();
        await releaseBarrier.promise;
      }
    },
    afterDestroy: async () => {
      if (failedRetry) {
        barrierEntered.resolve();
        await releaseBarrier.promise;
      }
    },
  });
  if (staged) {
    // Exercise the real staged-result producer and real Git ref settlement in this
    // disposable workspace. No source repository or hand-written Git object is used.
    const originalStartTunnel = harness.environments.startTunnel;
    harness.environments.startTunnel = vi.fn(
      async (...args: Parameters<typeof originalStartTunnel>) => {
        const tunnel = await originalStartTunnel(...args);
        const originalReconcile = tunnel.reconcileWorkspace.bind(tunnel);
        tunnel.reconcileWorkspace = vi.fn(async (request) => {
          const result = await originalReconcile(request);
          const raw = JSON.stringify({ version: 1, baseCommit: null, entries: [] });
          const ref = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
          const payloadRoot = path.join(root, "empty-staged-payload");
          await fs.mkdir(payloadRoot, { recursive: true });
          await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
            root: worktreePath,
            stagingRoot: payloadRoot,
            stagedResultRef: request.stagedResult!.ref,
            baseManifestRef: ref,
            currentManifestRef: ref,
            baseManifestRaw: raw,
            currentManifestRaw: raw,
          });
          request.stagedResult!.record(request.stagedResult!.ref);
          request.journal.commit(ref);

          return { ...result, manifestRef: ref, changed: false };
        });
        return tunnel;
      },
    );
  }
  const coordinated = coordinateWorkerPlacementDispatch(harness.service);
  const provisionEntered = createDeferred();
  const releaseProvision = createDeferred();
  if (pendingDispatch) {
    vi.mocked(harness.environments.create).mockImplementationOnce(async () => {
      provisionEntered.resolve();
      await releaseProvision.promise;
      return harness.ready;
    });
  }
  let dispatching: ReturnType<typeof coordinated.dispatch> | undefined;
  let active;
  if (failedRetry) {
    await expect(coordinated.dispatch(REQUEST)).rejects.toThrow("sync failed");
    active = placements.get(REQUEST.sessionId)!;
    expect(active.state).toBe("failed");
    expect(harness.environments.get(active.environmentId!)?.state).toBe("destroying");
  } else {
    dispatching = coordinated.dispatch(
      blockedInspection ? { ...REQUEST, executionMode: "remote-exec" } : REQUEST,
    );
    if (pendingDispatch) {
      await provisionEntered.promise;
      active = placements.get(REQUEST.sessionId)!;
      expect(active.state).toBe("provisioning");
    } else {
      active = await dispatching;
      expect(active.state).toBe("active");
    }
  }
  const admit = (runId: string) =>
    admitWorkerStopChat({
      context,
      storePath,
      entry,
      sessionKey: REQUEST.sessionKey,
      sessionId: REQUEST.sessionId,
      agentId: REQUEST.agentId,
      runId,
    });
  const oldRunId = name + "-before-stop-complete";
  const running = blockedInspection ? await admit(name + "-running").promise : undefined;
  let cancellationRecovery: Promise<void> | undefined;
  if (running?.ok) {
    running.value.activeRunAbort.controller.signal.addEventListener("abort", () => {
      if (cancellationNeedsRecovery) {
        // Real worker failure completion joins placement recovery before releasing admission.
        cancellationRecovery = coordinated.reconcileActive().finally(() => {
          running.value.cleanupAdmittedRun();
        });
      } else {
        running.value.cleanupAdmittedRun();
      }
    });
  }
  const inspectionEntered = createDeferred();
  const releaseInspection = createDeferred();
  if (blockedInspection) {
    vi.mocked(harness.environments.reconcileOnce).mockImplementationOnce(async () => {
      inspectionEntered.resolve();
      await releaseInspection.promise;
    });
  }
  const sweep = blockedInspection ? coordinated.reconcileActive() : undefined;
  if (sweep) {
    await inspectionEntered.promise;
  }
  let abortedDuringInspection = false;
  let destroyedDuringInspection = false;
  let old!: ReturnType<typeof admit>;
  let reclaimResult: { ok: boolean; state?: string; message?: string } | undefined;
  const reserveOld = () => {
    old = admit(oldRunId);
    if (blockedInspection || pendingDispatch) {
      void old.promise.then((result) => {
        if (result.ok) {
          result.value.cleanupAdmittedRun();
        }
      });
    }
    const reservation = context.dedupe.get(pendingChatSendDedupeKey(oldRunId));
    if (beforeStop) {
      expect((reservation?.payload as { status?: string } | undefined)?.status).toBe("accepted");
    }
    expect(context.chatAbortControllers.has(oldRunId)).toBe(false);
  };
  const stop = async () => {
    const reclaim = coordinated.reclaim(REQUEST).then(
      (value) => {
        return { ok: true, state: value.state };
      },
      (error: unknown) => {
        if (!(error instanceof Error)) {
          throw error;
        }
        return { ok: false, message: error.message };
      },
    );
    if (blockedInspection) {
      await setImmediate();
      abortedDuringInspection =
        running?.ok === true && running.value.activeRunAbort.controller.signal.aborted;
      destroyedDuringInspection = vi.mocked(harness.environments.destroy).mock.calls.length > 0;
      reserveOld();
      await setImmediate();
      releaseInspection.resolve();
    }
    if (pendingDispatch) {
      await setImmediate();
      reserveOld();
      releaseProvision.resolve();
      active = await dispatching!;
    }
    await Promise.race([barrierEntered.promise, reclaim]);
    if (!beforeStop && !blockedInspection && !pendingDispatch) {
      reserveOld();
    }
    releaseBarrier.resolve();
    reclaimResult = await reclaim;
    await sweep;
    await cancellationRecovery;
  };
  if (beforeStop) {
    // A preceding lifecycle owner holds ingress pending while Stop joins that
    // same owner. This fixes ordering without timer delays or editing ingress.
    await runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [REQUEST.sessionKey, REQUEST.sessionId],
      run: async () => {
        reserveOld();
        await stop();
      },
    });
  } else {
    await stop();
  }
  const oldResult = await old.promise;
  if (destroyFailure && !failedRetry) {
    expect(oldResult.ok).toBe(false);
    expect(harness.environments.get(active.environmentId!)?.state).toBe("destroying");
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
    expect(placements.listPendingWorkspaceResults()).toEqual([
      expect.objectContaining({ workspaceAcceptedAtMs: expect.any(Number) }),
    ]);
    await coordinated.reconcileActive();
  }
  const finalPlacement = placements.get(REQUEST.sessionId);
  const environment = harness.environments.get(active.environmentId!);
  expect(environment?.state).toBe("destroyed");
  expect(harness.environments.destroy).toHaveBeenCalledTimes(destroyFailure ? 2 : 1);
  if (oldResult.ok) {
    oldResult.value.cleanupAdmittedRun();
    clearAgentRunContext(oldRunId, oldResult.value.lifecycleGeneration);
  }
  const freshRunId = name + "-explicit-after-stop";
  const fresh = admit(freshRunId);
  const freshResult = await fresh.promise;
  if (freshResult.ok) {
    freshResult.value.cleanupAdmittedRun();
    clearAgentRunContext(freshRunId, freshResult.value.lifecycleGeneration);
  }
  const report = {
    name,
    destroyFailure,
    beforeStop,
    staged,
    reclaimResult,
    finalPlacementState: finalPlacement?.state,
    environmentState: environment?.state,
    providerDestroyAttempts: vi.mocked(harness.environments.destroy).mock.calls.length,
    pendingWorkspaceResults: placements.listPendingWorkspaceResults().length,
    preexistingAdmissionAccepted: oldResult.ok,
    preexistingResponses: old.respond.mock.calls,
    explicitNewAdmissionAccepted: freshResult.ok,
    approvalAttachRevocationCount: revocations.length,
    abortedDuringInspection,
    destroyedDuringInspection,
    harnessOrder: [...harness.log],
  };
  context.chatRunState.clear();
  if (running?.ok) {
    running.value.cleanupAdmittedRun();
    clearAgentRunContext(name + "-running", running.value.lifecycleGeneration);
  }
  return report;
}

it.each([false, true])(
  "Stop cancels before unrelated inspection releases (recovery=%s)",
  async (cancellationNeedsRecovery) => {
    const r = await scenario(`blocked-inspection-${cancellationNeedsRecovery}`, {
      blockedInspection: true,
      cancellationNeedsRecovery,
    });
    expect(r.abortedDuringInspection).toBe(true);
    expect(r.destroyedDuringInspection).toBe(false);
    expect(r.preexistingAdmissionAccepted).toBe(false);
    expect(r.reclaimResult).toEqual({ ok: true, state: "reclaimed" });
    expect(r.explicitNewAdmissionAccepted).toBe(true);
  },
);

it("Stop fences ingress during provisioning without cancelling its dispatch producer", async () => {
  const r = await scenario("pending-dispatch", { pendingDispatch: true });
  expect(r.preexistingAdmissionAccepted).toBe(false);
  expect(r.reclaimResult).toEqual({ ok: true, state: "reclaimed" });
  expect(r.explicitNewAdmissionAccepted).toBe(true);
});

it("successful Stop cancels a preexisting send waiting on its lifecycle fence", async () => {
  const r = await scenario("successful-stop");
  expect(r.reclaimResult).toEqual({ ok: true, state: "reclaimed" });
  expect(r.explicitNewAdmissionAccepted).toBe(true);
  expect(
    r.preexistingAdmissionAccepted,
    "a send already waiting when Stop completes must not revive the worker",
  ).toBe(false);
});
it("provider stop failure plus successful recovery still cancels preexisting ingress", async () => {
  const r = await scenario("failed-stop-recovered-cleanup", { destroyFailure: true });
  expect(r.reclaimResult).toEqual({ ok: false, message: "destroy pending" });
  expect(r.explicitNewAdmissionAccepted).toBe(true);
  expect(
    r.preexistingAdmissionAccepted,
    "provider cleanup failure must not let pending ingress escape Stop",
  ).toBe(false);
});

it("a reservation preceding Stop cannot revive a successfully reclaimed worker", async () => {
  const r = await scenario("pre-stop-reservation", { beforeStop: true });
  expect(r.reclaimResult).toEqual({ ok: true, state: "reclaimed" });
  expect(r.explicitNewAdmissionAccepted).toBe(true);
  expect(r.preexistingAdmissionAccepted).toBe(false);
});
it("accepted staged reclaim recovers provider cleanup but must reject pre-Stop ingress", async () => {
  const r = await scenario("accepted-staged-stop-recovery", {
    destroyFailure: true,
    beforeStop: true,
    staged: true,
  });
  expect(r.reclaimResult).toEqual({ ok: false, message: "destroy pending" });
  expect(r.finalPlacementState).toBe("reclaimed");
  expect(r.pendingWorkspaceResults).toBe(0);
  expect(r.explicitNewAdmissionAccepted).toBe(true);
  expect(r.preexistingAdmissionAccepted).toBe(false);
});

it.each([false, true])(
  "Stop of an already failed placement cancels pending ingress (before=%s)",
  async (beforeStop) => {
    const r = await scenario(`failed-retry-${beforeStop}`, {
      destroyFailure: true,
      beforeStop,
      failedRetry: true,
    });
    expect(r.reclaimResult).toEqual({ ok: true, state: "local" });
    expect(r.environmentState).toBe("destroyed");
    expect(r.providerDestroyAttempts).toBe(2);
    expect(r.explicitNewAdmissionAccepted).toBe(true);
    expect(
      r.preexistingAdmissionAccepted,
      "failed cleanup must not release old pending work into local execution",
    ).toBe(false);
  },
);

it("an idempotent failed-cleanup result does not cancel work already on the local placement", async () => {
  const storePath = path.join(os.tmpdir(), "failed-already-local.sqlite");
  const entry = { sessionId: REQUEST.sessionId, updatedAt: Date.now() };
  const target = {
    storePath,
    canonicalKey: REQUEST.sessionKey,
    storeKeys: [REQUEST.sessionKey],
    agentId: REQUEST.agentId,
    store: { [REQUEST.sessionKey]: entry },
  };
  const local = { state: "local", sessionId: REQUEST.sessionId, generation: 4 };
  const cancel = vi.fn();
  const barriers = createGatewayWorkerPlacementReclaimBarriers({
    placements: { get: () => local as never, waitForTurnClaimRelease: vi.fn() },
    loadSessionRuntime: async () =>
      ({
        managedWorktrees: { findLiveByOwner: () => undefined },
        resolveGatewaySessionStoreTargetWithStore: () => target,
        resolveCanonicalSessionEntryFromStoreKeys: () => entry,
      }) as never,
    cancelSessionWork: cancel,
    revokeSessionAuthority: vi.fn(),
  });
  const reclaimed = await barriers.runFailedReclaimBarrier({
    ...REQUEST,
    reclaim: async () => local,
  } as never);
  expect(reclaimed).toBe(local);
  expect(cancel).not.toHaveBeenCalled();
});
