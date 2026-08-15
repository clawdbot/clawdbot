import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  type DispatchStage,
  type PlacementStore,
  FORCED_WORKER_ABANDONMENT_ERROR,
  REQUEST,
} from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { WorkerWorkspaceOperatorRecoveryError } from "./tunnel-contract.js";

const OPERATOR_RECOVERY_GUIDANCE =
  "Use Stop cloud worker and confirm abandoning the result to destroy the environment; unreconciled remote workspace changes will be permanently lost";

describe("worker placement dispatch", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let placementStore: PlacementStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-dispatch-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placementStore = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("recovers a completed turn's durable pending workspace result before stale-claim teardown", async () => {
    const harness = createHarness(placementStore);
    const active = harness.placements.seedActive(2);
    harness.markEnvironmentOwnerEpoch(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "completed-turn-claim",
      runId: "completed-turn-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    placementStore.markWorkspaceResultPending(claim);

    await harness.service.reconcile();
    expect(harness.placements.current()).toMatchObject({
      state: "active",
      turnClaim: { claimId: claim.claimId },
    });

    placementStore.handoffWorkspaceResultRecovery(claim);

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "active",
      turnClaim: null,
      workspaceBaseManifestRef: harness.reconciledManifestRef,
    });
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });

  it("destroys and reclaims a pending result owned by a previous gateway instance", async () => {
    const originalHarness = createHarness(placementStore);
    const active = originalHarness.placements.seedActive(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "restarted-turn-claim",
      runId: "restarted-turn-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    placementStore.markWorkspaceResultPending(claim);

    const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    const restartedHarness = createHarness(restartedStore);
    restartedHarness.markEnvironmentOwnerEpoch(2);
    await restartedHarness.service.reconcile();

    expect(restartedHarness.placements.current()).toMatchObject({
      state: "reclaimed",
      turnClaim: null,
      workspaceBaseManifestRef: restartedHarness.reconciledManifestRef,
    });
    expect(restartedStore.listPendingWorkspaceResults()).toEqual([]);
    expect(restartedHarness.environments.destroy).toHaveBeenCalledOnce();
    expect(restartedHarness.log).not.toContain("workspace:resume");
  });

  it.each(["reconcile", "reconcileActive"] as const)(
    "%s refreshes provider facts before recovering an unstaged pending result",
    async (reconcile) => {
      const originalHarness = createHarness(placementStore);
      const active = originalHarness.placements.seedActive(2);
      originalHarness.markEnvironmentOwnerEpoch(2);
      if (active.state !== "active") {
        throw new Error("active placement fixture was not active");
      }
      const claim = placementStore.claimTurn({
        ...REQUEST,
        claimId: "stale-bundle-pending-claim",
        runId: "stale-bundle-pending-run",
        owner: {
          kind: "worker",
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
      });
      placementStore.markWorkspaceResultPending(claim);

      const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
      const restartedHarness = createHarness(restartedStore);
      restartedHarness.markEnvironmentOwnerEpoch(2);

      await restartedHarness.service[reconcile]();

      expect(restartedHarness.log.indexOf("environment:reconcile")).toBeLessThan(
        restartedHarness.log.indexOf("workspace:reconcile"),
      );
      expect(restartedHarness.placements.current()).toMatchObject({
        state: "reclaimed",
        turnClaim: null,
        workspaceBaseManifestRef: restartedHarness.reconciledManifestRef,
      });
      expect(restartedStore.listPendingWorkspaceResults()).toEqual([]);
    },
  );

  it("keeps a previous-instance pending result fenced when another session is attached", async () => {
    const originalHarness = createHarness(placementStore);
    const active = originalHarness.placements.seedActive(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "shared-worker-claim",
      runId: "shared-worker-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    placementStore.markWorkspaceResultPending(claim);

    const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    const restartedHarness = createHarness(restartedStore);
    restartedHarness.markEnvironmentAttachments([REQUEST.sessionId, "session-2"]);
    await restartedHarness.service.reconcile();

    expect(restartedHarness.placements.current()).toMatchObject({
      state: "active",
      turnClaim: { claimId: claim.claimId },
    });
    expect(restartedStore.listPendingWorkspaceResults()).toHaveLength(1);
    expect(restartedHarness.environments.destroy).not.toHaveBeenCalled();

    await restartedHarness.service.forceDestroyEnvironment(active.environmentId);
    expect(restartedStore.listPendingWorkspaceResults()).toEqual([]);
  });

  it("recovers a draining turn result using the admitted claim generation", async () => {
    const harness = createHarness(placementStore);
    const active = harness.placements.seedActive(2);
    harness.markEnvironmentOwnerEpoch(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "draining-result-claim",
      runId: "draining-result-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    const draining = placementStore.startDrain({
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    expect(draining.generation).not.toBe(claim.placementGeneration);
    placementStore.markWorkspaceResultPending(claim);
    placementStore.handoffWorkspaceResultRecovery(claim);

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      turnClaim: null,
      workspaceBaseManifestRef: harness.reconciledManifestRef,
    });
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
    expect(harness.log.indexOf("workspace:resume")).toBeLessThan(
      harness.log.indexOf("teardown:destroy"),
    );
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("keeps the pending result fenced when same-instance quiescence cannot resume", async () => {
    const harness = createHarness(placementStore, { resumeFails: true });
    const active = harness.placements.seedActive(2);
    harness.markEnvironmentOwnerEpoch(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "resume-failure-claim",
      runId: "resume-failure-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    placementStore.markWorkspaceResultPending(claim);
    placementStore.handoffWorkspaceResultRecovery(claim);

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "active",
      turnClaim: { claimId: claim.claimId },
    });
    expect(placementStore.listPendingWorkspaceResults()).toHaveLength(1);
    expect(harness.environments.destroy).not.toHaveBeenCalled();

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "active",
      turnClaim: { claimId: claim.claimId },
    });
    expect(placementStore.listPendingWorkspaceResults()).toHaveLength(1);
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });

  it("retains final-fence terminal recovery until forced abandonment after restart", async () => {
    const terminalMessage =
      "Worker workspace sync failed: workspace quiescence recovery timed out; lease retained for operator recovery";
    const harness = createHarness(placementStore, {
      leaseError: new Error("Worker workspace quiescence renewal failed", {
        cause: new WorkerWorkspaceOperatorRecoveryError(new Error(terminalMessage)),
      }),
    });
    const active = harness.placements.seedActive(2);
    harness.markEnvironmentOwnerEpoch(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "terminal-resume-failure-claim",
      runId: "terminal-resume-failure-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    placementStore.markWorkspaceResultPending(claim);
    placementStore.handoffWorkspaceResultRecovery(claim);

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: expect.stringContaining(OPERATOR_RECOVERY_GUIDANCE),
      turnClaim: null,
    });
    expect(placementStore.listPendingWorkspaceResults()).toHaveLength(1);
    expect(harness.environments.destroy).not.toHaveBeenCalled();

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: expect.stringContaining(OPERATOR_RECOVERY_GUIDANCE),
      turnClaim: null,
    });
    expect(placementStore.listPendingWorkspaceResults()).toHaveLength(1);
    expect(harness.environments.destroy).not.toHaveBeenCalled();

    const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    const restartedHarness = createHarness(restartedStore);
    await restartedHarness.service.reconcile();

    expect(restartedHarness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: expect.stringContaining(OPERATOR_RECOVERY_GUIDANCE),
      turnClaim: null,
    });
    expect(restartedStore.listPendingWorkspaceResults()).toHaveLength(1);
    expect(restartedHarness.environments.destroy).not.toHaveBeenCalled();

    await restartedHarness.service.forceDestroyEnvironment(active.environmentId);

    expect(restartedHarness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: FORCED_WORKER_ABANDONMENT_ERROR,
      turnClaim: null,
    });
    expect(restartedStore.listPendingWorkspaceResults()).toEqual([]);
  });

  it("drains a running nested session operation before retaining terminal recovery", async () => {
    const terminalMessage =
      "Worker workspace sync failed: workspace quiescence recovery timed out; lease retained for operator recovery";
    const harness = createHarness(placementStore, {
      leaseError: new WorkerWorkspaceOperatorRecoveryError(new Error(terminalMessage)),
    });
    const active = harness.placements.seedActive(2);
    harness.markEnvironmentOwnerEpoch(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "terminal-running-operation-claim",
      runId: "terminal-running-operation-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    placementStore.markWorkspaceResultPending(claim);
    placementStore.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    const binding = {
      sessionId: claim.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      runId: claim.runId,
    };
    expect(
      placementStore.beginWorkerSessionToolOperation({
        binding,
        toolName: "sessions_send",
        toolCallId: "terminal-running-operation-call",
        requestDigest: "terminal-running-operation-digest",
      }),
    ).toMatchObject({ kind: "execute" });
    placementStore.handoffWorkspaceResultRecovery(claim);

    const reconciliation = harness.service.reconcile();

    await vi.waitFor(() => {
      expect(placementStore.isWorkerTurnToolAuthorized(binding, "sessions_send")).toBe(false);
    });
    expect(harness.placements.current()).toMatchObject({
      state: "active",
      turnClaim: { claimId: claim.claimId },
    });
    expect(placementStore.listPendingWorkspaceResults()).toHaveLength(1);

    expect(
      placementStore.completeWorkerSessionToolOperation({
        sourceSessionId: claim.sessionId,
        sourceClaimId: claim.claimId,
        toolCallId: "terminal-running-operation-call",
        requestDigest: "terminal-running-operation-digest",
        resultJson: '{"status":"ok"}',
      }),
    ).toBe(true);
    await reconciliation;

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      turnClaim: null,
    });
    expect(placementStore.listPendingWorkspaceResults()).toHaveLength(1);
  });

  it("fails a pending result with diagnostics when its worker is proven lost", async () => {
    const harness = createHarness(placementStore);
    const active = harness.placements.seedActive(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "lost-result-claim",
      runId: "lost-result-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    placementStore.markWorkspaceResultPending(claim);
    placementStore.handoffWorkspaceResultRecovery(claim);
    harness.markEnvironmentDestroyed();

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: "cloud worker disappeared: environment state destroyed",
      terminalReason: "cloud worker disappeared: environment state destroyed",
      terminalAtMs: expect.any(Number),
    });
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
  });

  it("reclaims an accepted pending result after a post-destroy gateway restart", async () => {
    const harness = createHarness(placementStore);
    const active = harness.placements.seedActive(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "accepted-lost-result-claim",
      runId: "accepted-lost-result-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    placementStore.markWorkspaceResultPending(claim);
    placementStore.updateWorkspaceBaseManifest({
      claim,
      manifestRef: harness.reconciledManifestRef,
    });
    placementStore.acceptWorkspaceResult(claim);
    placementStore.handoffWorkspaceResultRecovery(claim);
    harness.markEnvironmentDestroyed();

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "reclaimed",
      turnClaim: null,
      workspaceBaseManifestRef: harness.reconciledManifestRef,
    });
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
  });

  it("coalesces overlapping reclaim requests and accepts completed retries", async () => {
    const harness = createHarness(placementStore);
    await harness.service.dispatch(REQUEST);
    const request = {
      sessionId: REQUEST.sessionId,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
    };

    const [first, second] = await Promise.all([
      harness.service.reclaim(request),
      harness.service.reclaim(request),
    ]);
    const retry = await harness.service.reclaim(request);

    expect(first).toMatchObject({ state: "reclaimed" });
    expect(second).toEqual(first);
    expect(retry).toEqual(first);
    expect(harness.environments.destroy).toHaveBeenCalledTimes(1);
  });

  it("keeps the active worker when inbound workspace reconciliation conflicts", async () => {
    const harness = createHarness(placementStore, { reconcileFails: true });
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      }),
    ).rejects.toThrow("workspace conflict");

    expect(harness.placements.current()).toMatchObject({ state: "active" });
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(harness.log).toContain("workspace:resume");
  });

  it("keeps the active worker when the remote workspace changes after local acceptance", async () => {
    const harness = createHarness(placementStore, { verifyFails: true });
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      }),
    ).rejects.toThrow("workspace changed after reconciliation");

    expect(harness.placements.current()).toMatchObject({
      state: "active",
      workspaceBaseManifestRef: harness.reconciledManifestRef,
    });
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(harness.log).toContain("workspace:resume");
  });

  it("keeps the active worker when its quiescence lease expires", async () => {
    const harness = createHarness(placementStore, { leaseFails: true });
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      }),
    ).rejects.toThrow("workspace quiescence expired");

    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(harness.log).toContain("workspace:resume");
  });

  it("records terminal operator recovery from explicit reclaim", async () => {
    const terminalMessage =
      "Worker workspace sync failed: workspace quiescence recovery timed out; lease retained for operator recovery";
    const harness = createHarness(placementStore, {
      leaseError: new Error("Worker workspace quiescence renewal failed", {
        cause: new WorkerWorkspaceOperatorRecoveryError(new Error(terminalMessage)),
      }),
    });
    await harness.service.dispatch(REQUEST);
    const request = {
      sessionId: REQUEST.sessionId,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
    };

    await expect(harness.service.reclaim(request)).rejects.toThrow(
      "Worker workspace quiescence renewal failed",
    );

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: expect.stringContaining(OPERATOR_RECOVERY_GUIDANCE),
      turnClaim: null,
    });
    expect(placementStore.listPendingWorkspaceResults()).toHaveLength(1);
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    await expect(harness.service.reclaim(request)).rejects.toThrow(
      "Failed cloud worker environment must be stopped before reclaim",
    );
  });

  it("waits for a running nested operation before explicit reclaim returns", async () => {
    const leaseBarrier = createDeferred();
    const terminalMessage =
      "Worker workspace sync failed: workspace quiescence recovery timed out; lease retained for operator recovery";
    const harness = createHarness(placementStore, {
      leaseBarrier: leaseBarrier.promise,
      leaseError: new WorkerWorkspaceOperatorRecoveryError(new Error(terminalMessage)),
    });
    await harness.service.dispatch(REQUEST);
    const reclaim = harness.service.reclaim({
      sessionId: REQUEST.sessionId,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
    });

    await vi.waitFor(() => {
      expect(placementStore.listPendingWorkspaceResults()).toHaveLength(1);
    });
    const pending = placementStore.listPendingWorkspaceResults()[0]!;
    const claim = {
      sessionId: pending.sessionId,
      claimId: pending.claimId,
      runId: pending.runId,
      placementGeneration: pending.placementGeneration,
      owner: {
        kind: "worker" as const,
        environmentId: pending.environmentId,
        ownerEpoch: pending.ownerEpoch,
      },
    };
    const binding = {
      sessionId: claim.sessionId,
      environmentId: claim.owner.environmentId,
      ownerEpoch: claim.owner.ownerEpoch,
      runId: claim.runId,
    };
    placementStore.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    expect(
      placementStore.beginWorkerSessionToolOperation({
        binding,
        toolName: "sessions_send",
        toolCallId: "explicit-reclaim-running-call",
        requestDigest: "explicit-reclaim-running-digest",
      }),
    ).toMatchObject({ kind: "execute" });
    let settled = false;
    void reclaim.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    leaseBarrier.resolve();
    await vi.waitFor(() => {
      expect(placementStore.isWorkerTurnToolAuthorized(binding, "sessions_send")).toBe(false);
    });
    expect(settled).toBe(false);
    expect(
      placementStore.completeWorkerSessionToolOperation({
        sourceSessionId: claim.sessionId,
        sourceClaimId: claim.claimId,
        toolCallId: "explicit-reclaim-running-call",
        requestDigest: "explicit-reclaim-running-digest",
        resultJson: '{"status":"ok"}',
      }),
    ).toBe(true);

    await expect(reclaim).rejects.toThrow(terminalMessage);
    expect(harness.placements.current()).toMatchObject({ state: "failed", turnClaim: null });
  });

  it("keeps the active worker when the accepted local result changes", async () => {
    const harness = createHarness(placementStore, { localVerifyFails: true });
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      }),
    ).rejects.toThrow("local workspace changed after reconciliation");

    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(harness.log).toContain("workspace:resume");
  });

  it("keeps the accepted placement active when provider destruction is not proven", async () => {
    const harness = createHarness(placementStore, { destroyFails: true });
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      }),
    ).rejects.toThrow("destroy pending");

    expect(harness.placements.current()).toMatchObject({
      state: "active",
      workspaceBaseManifestRef: harness.reconciledManifestRef,
      turnClaim: { owner: "worker" },
    });
    expect(placementStore.listPendingWorkspaceResults()).toMatchObject([
      { workspaceAcceptedAtMs: expect.any(Number) },
    ]);
    expect(harness.log).not.toContain("placement:draining");
    expect(harness.log).toContain("workspace:resume");
  });

  it.each<DispatchStage>([
    "barrier",
    "workspace",
    "create",
    "sync",
    "attach",
    "tunnel:attached",
    "activation",
  ])("fails closed and tears down acquired resources when %s fails", async (failAt) => {
    const harness = createHarness(placementStore, { failAt });

    await expect(harness.service.dispatch(REQUEST)).rejects.toThrow(`${failAt} failed`);

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: `${failAt} failed`,
    });
    const failedAt = harness.log.indexOf("placement:failed");
    expect(failedAt).toBeGreaterThan(-1);
    const environmentAcquired = !["barrier", "workspace"].includes(failAt);
    expect(harness.log.includes("teardown:stop")).toBe(environmentAcquired);
    expect(harness.log.includes("teardown:destroy")).toBe(environmentAcquired);
    if (environmentAcquired) {
      expect(failedAt).toBeGreaterThan(harness.log.indexOf("teardown:destroy"));
    }
  });

  it("does not fail or tear down a dispatch owned by another invocation", async () => {
    placementStore.startDispatch(REQUEST);
    const harness = createHarness(placementStore);

    await expect(harness.service.dispatch(REQUEST)).rejects.toThrow(
      "Cannot dispatch session session-1 from placement requested",
    );

    expect(harness.placements.current()).toMatchObject({ state: "requested" });
    expect(harness.log).not.toContain("placement:failed");
    expect(harness.log).not.toContain("teardown:destroy");
  });

  it("persists pending teardown evidence after placement is fenced", async () => {
    const harness = createHarness(placementStore, { failAt: "sync", destroyFails: true });

    await expect(harness.service.dispatch(REQUEST)).rejects.toThrow("sync failed");

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: expect.stringContaining("environment destroy: destroy pending"),
    });
    expect(harness.log.filter((entry) => entry === "placement:failed")).toHaveLength(1);
  });

  it("adopts an exact active environment after restart without reprovisioning", async () => {
    const harness = createHarness(placementStore);
    await harness.environments.attachSession({
      environmentId: harness.ready.environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    harness.placements.seedActive(harness.attached.ownerEpoch);
    harness.log.length = 0;

    await harness.service.reconcile();

    expect(harness.log).toEqual([
      "environment:reconcile",
      "workspace",
      "tunnel:attached",
      "placement:adopted",
    ]);
    expect(harness.environments.create).not.toHaveBeenCalled();
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });

  it("reclaims an active pre-v2 worker instead of adopting its stale launch contract", async () => {
    const harness = createHarness(placementStore);
    await harness.environments.attachSession({
      environmentId: harness.ready.environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    harness.placements.seedActive(harness.attached.ownerEpoch);
    harness.markEnvironmentProtocolFeatures([]);

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({ state: "reclaimed" });
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("fails an active placement whose environment is already terminal after restart", async () => {
    const harness = createHarness(placementStore);
    harness.placements.seedActive(harness.attached.ownerEpoch);
    harness.markEnvironmentDestroyed();
    harness.log.length = 0;

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      environmentId: harness.ready.environmentId,
      activeOwnerEpoch: harness.attached.ownerEpoch,
      recoveryError: "cloud worker disappeared: environment state destroyed",
      terminalReason: "cloud worker disappeared: environment state destroyed",
      terminalAtMs: expect.any(Number),
    });
    expect(harness.log).toEqual([
      "environment:reconcile",
      "workspace",
      "placement:draining",
      "placement:reconciling",
      "placement:failed",
    ]);
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });

  it("does not reclaim an active placement with an unresolved workspace journal", async () => {
    const harness = createHarness(placementStore);
    harness.placements.seedActive(harness.attached.ownerEpoch);
    const active = placementStore.get(REQUEST.sessionId);
    expect(active?.state).toBe("active");
    if (active?.state !== "active") {
      return;
    }
    placementStore.beginWorkspaceReconciliation(
      {
        sessionId: active.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        placementGeneration: active.generation,
      },
      {
        version: 1,
        temporaryNonce: "f".repeat(32),
        baseManifestRef: active.workspaceBaseManifestRef,
        currentManifestRef: harness.reconciledManifestRef,
        baseEntries: [],
        appliedEntries: [],
        baseTree: "f".repeat(40),
        basePackSha256: createHash("sha256").update("").digest("hex"),
        basePack: Buffer.alloc(0),
      },
    );
    harness.markEnvironmentDestroyed();
    harness.log.length = 0;

    await harness.service.reconcileActive();

    expect(harness.placements.current()).toMatchObject({ state: "active" });
    expect(harness.log).toEqual(["environment:reconcile"]);
  });

  it("fails closed when an active worker turn claim cannot be proven live after restart", async () => {
    const harness = createHarness(placementStore);
    await harness.environments.attachSession({
      environmentId: harness.ready.environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    harness.placements.seedActive(harness.attached.ownerEpoch);
    placementStore.claimTurn({
      ...REQUEST,
      claimId: "claim-1",
      runId: "run-1",
      owner: {
        kind: "worker",
        environmentId: harness.attached.environmentId,
        ownerEpoch: harness.attached.ownerEpoch,
      },
    });
    harness.log.length = 0;

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      turnClaim: null,
      recoveryError: "Active worker turn claim cannot be proven live after gateway restart",
    });
    expect(harness.log).toEqual([
      "environment:reconcile",
      "workspace",
      "placement:draining",
      "placement:reconciling",
      "teardown:stop",
      "teardown:destroy",
      "placement:failed",
    ]);
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
  });

  it("resumes a synced starting placement after restart", async () => {
    const harness = createHarness(placementStore);
    harness.placements.seedStarting();
    harness.log.length = 0;

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "active",
      environmentId: harness.ready.environmentId,
      activeOwnerEpoch: harness.attached.ownerEpoch,
    });
    expect(harness.log).toEqual([
      "environment:reconcile",
      "workspace",
      "attach",
      "tunnel:attached",
      "activation",
      "placement:active",
    ]);
    expect(harness.environments.create).not.toHaveBeenCalled();
  });

  it("tears down a starting pre-v2 worker instead of resuming its stale launch contract", async () => {
    const harness = createHarness(placementStore);
    harness.placements.seedStarting();
    harness.markEnvironmentProtocolFeatures([]);

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: "Interrupted worker dispatch cannot safely resume",
    });
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("finishes an interrupted drain through reconciliation before failure", async () => {
    const harness = createHarness(placementStore);
    harness.placements.seedDraining(harness.attached.ownerEpoch);
    harness.log.length = 0;

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      turnClaim: null,
      recoveryError: "Worker dispatch interrupted in draining",
    });
    expect(harness.log).toEqual([
      "environment:reconcile",
      "workspace",
      "placement:reconciling",
      "teardown:stop",
      "teardown:destroy",
      "placement:failed",
    ]);
  });

  it("drains, tears down, and reclaims an idle active placement with a mismatched owner", async () => {
    const harness = createHarness(placementStore);
    harness.placements.seedActive(99);

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "reclaimed",
    });
    expect(harness.log).toEqual([
      "environment:reconcile",
      "workspace",
      "placement:draining",
      "placement:reconciling",
      "teardown:stop",
      "teardown:destroy",
      "placement:reclaimed",
    ]);

    const destroyCalls = vi.mocked(harness.environments.destroy).mock.calls.length;
    await harness.service.reconcile();
    expect(harness.environments.destroy).toHaveBeenCalledTimes(destroyCalls);
  });

  it("preserves a live active turn claim during runtime reconciliation", async () => {
    const harness = createHarness(placementStore);
    await harness.environments.attachSession({
      environmentId: harness.ready.environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    harness.placements.seedActive(harness.attached.ownerEpoch);
    placementStore.claimTurn({
      ...REQUEST,
      claimId: "claim-1",
      runId: "run-1",
      owner: {
        kind: "worker",
        environmentId: harness.attached.environmentId,
        ownerEpoch: harness.attached.ownerEpoch,
      },
    });
    harness.log.length = 0;

    await harness.service.reconcileActive();

    expect(harness.placements.current()).toMatchObject({
      state: "active",
      turnClaim: {
        claimId: "claim-1",
        runId: "run-1",
        owner: "worker",
      },
    });
    expect(harness.log).toEqual(["environment:reconcile"]);
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });

  it("fences a live turn before tearing down a mismatched runtime owner", async () => {
    const harness = createHarness(placementStore);
    await harness.environments.attachSession({
      environmentId: harness.ready.environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    harness.placements.seedActive(harness.attached.ownerEpoch);
    placementStore.claimTurn({
      ...REQUEST,
      claimId: "claim-1",
      runId: "run-1",
      owner: {
        kind: "worker",
        environmentId: harness.attached.environmentId,
        ownerEpoch: harness.attached.ownerEpoch,
      },
    });
    harness.markEnvironmentOwnerEpoch(harness.attached.ownerEpoch + 1);
    harness.log.length = 0;

    await harness.service.reconcileActive();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      turnClaim: null,
      recoveryError: "Active worker placement does not match its environment owner",
    });
    expect(harness.log).toEqual([
      "environment:reconcile",
      "placement:draining",
      "placement:reconciling",
      "teardown:stop",
      "teardown:destroy",
      "placement:failed",
    ]);
  });

  it("fails a terminal active environment during runtime reconciliation", async () => {
    const harness = createHarness(placementStore);
    harness.placements.seedActive(harness.attached.ownerEpoch);
    harness.markEnvironmentDestroyed();
    harness.log.length = 0;

    await harness.service.reconcileActive();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: "cloud worker disappeared: environment state destroyed",
      terminalReason: "cloud worker disappeared: environment state destroyed",
    });
    expect(harness.log).toEqual([
      "environment:reconcile",
      "placement:draining",
      "placement:reconciling",
      "placement:failed",
    ]);
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });

  it("limits requested runtime reconciliation to one environment", async () => {
    const harness = createHarness(placementStore);
    harness.placements.seedActive(harness.attached.ownerEpoch);
    harness.markEnvironmentDestroyed();
    harness.log.length = 0;

    await harness.service.reconcileActive("worker-other");

    expect(harness.placements.current()).toMatchObject({ state: "active" });
    expect(harness.log).toEqual(["environment:reconcile"]);

    await harness.service.reconcileActive(harness.ready.environmentId);

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: "cloud worker disappeared: environment state destroyed",
    });
  });

  it("does not retry unrelated failed teardown during requested reconciliation", async () => {
    const harness = createHarness(placementStore, { failAt: "sync", destroyFails: true });
    await expect(harness.service.dispatch(REQUEST)).rejects.toThrow("sync failed");
    harness.log.length = 0;
    vi.mocked(harness.environments.destroy).mockClear();

    await harness.service.reconcileActive("worker-other");

    expect(harness.placements.current()).toMatchObject({ state: "failed" });
    expect(harness.log).toEqual(["environment:reconcile"]);
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });

  it("fences a turn admitted immediately before runtime drain", async () => {
    const harness = createHarness(placementStore, { claimOnDrain: true });
    harness.placements.seedActive(harness.attached.ownerEpoch);
    harness.markEnvironmentDestroyed();
    harness.log.length = 0;

    await harness.service.reconcileActive();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      turnClaim: null,
      recoveryError: "cloud worker disappeared: environment state destroyed",
    });
    expect(harness.log).toEqual([
      "environment:reconcile",
      "placement:draining",
      "placement:reconciling",
      "teardown:stop",
      "teardown:destroy",
      "placement:failed",
    ]);
  });

  it("leaves in-flight dispatch preparation untouched during runtime reconciliation", async () => {
    const harness = createHarness(placementStore);
    harness.placements.seedStarting();
    harness.log.length = 0;

    await harness.service.reconcileActive();

    expect(harness.placements.current()).toMatchObject({ state: "starting" });
    expect(harness.log).toEqual(["environment:reconcile"]);
    expect(harness.environments.attachSession).not.toHaveBeenCalled();
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });
});
