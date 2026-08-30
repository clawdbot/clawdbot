import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  destroyFailure: boolean,
  beforeStop = false,
  staged = false,
  failedRetry = false,
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
  let active;
  if (failedRetry) {
    await expect(coordinated.dispatch(REQUEST)).rejects.toThrow("sync failed");
    active = placements.get(REQUEST.sessionId)!;
    expect(active.state).toBe("failed");
    expect(harness.environments.get(active.environmentId!)?.state).toBe("destroying");
  } else {
    active = await coordinated.dispatch(REQUEST);
    expect(active.state).toBe("active");
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
  let old!: ReturnType<typeof admit>;
  let reclaimResult: { ok: boolean; state?: string; message?: string } | undefined;
  const reserveOld = () => {
    old = admit(oldRunId);
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
    await barrierEntered.promise;
    if (!beforeStop) {
      reserveOld();
    }
    releaseBarrier.resolve();
    reclaimResult = await reclaim;
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
    harnessOrder: [...harness.log],
  };
  context.chatRunState.clear();
  return report;
}

it("successful Stop cancels a preexisting send waiting on its lifecycle fence", async () => {
  const r = await scenario("successful-stop", false);
  expect(r.reclaimResult).toEqual({ ok: true, state: "reclaimed" });
  expect(r.explicitNewAdmissionAccepted).toBe(true);
  expect(
    r.preexistingAdmissionAccepted,
    "a send already waiting when Stop completes must not revive the worker",
  ).toBe(false);
});
it("provider stop failure plus successful recovery still cancels preexisting ingress", async () => {
  const r = await scenario("failed-stop-recovered-cleanup", true);
  expect(r.reclaimResult).toEqual({ ok: false, message: "destroy pending" });
  expect(r.explicitNewAdmissionAccepted).toBe(true);
  expect(
    r.preexistingAdmissionAccepted,
    "provider cleanup failure must not let pending ingress escape Stop",
  ).toBe(false);
});

it("a reservation preceding Stop cannot revive a successfully reclaimed worker", async () => {
  const r = await scenario("pre-stop-reservation", false, true);
  expect(r.reclaimResult).toEqual({ ok: true, state: "reclaimed" });
  expect(r.explicitNewAdmissionAccepted).toBe(true);
  expect(r.preexistingAdmissionAccepted).toBe(false);
});
it("accepted staged reclaim recovers provider cleanup but must reject pre-Stop ingress", async () => {
  const r = await scenario("accepted-staged-stop-recovery", true, true, true);
  expect(r.reclaimResult).toEqual({ ok: false, message: "destroy pending" });
  expect(r.finalPlacementState).toBe("reclaimed");
  expect(r.pendingWorkspaceResults).toBe(0);
  expect(r.explicitNewAdmissionAccepted).toBe(true);
  expect(r.preexistingAdmissionAccepted).toBe(false);
});

it.each([false, true])(
  "Stop of an already failed placement cancels pending ingress (before=%s)",
  async (beforeStop) => {
    const r = await scenario(`failed-retry-${beforeStop}`, true, beforeStop, false, true);
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
