import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_LAUNCH_V2_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  type DispatchStage,
  type PlacementStore,
  REQUEST,
  seedSyncingPlacement,
} from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { deriveEnvironmentIntent } from "./service-contract.js";

describe("worker placement dispatch", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let placementStore: PlacementStore;
  const createTestHarness = (
    options: Parameters<typeof createHarness>[1] = {},
    store: PlacementStore = placementStore,
  ) => createHarness(store, { workspacePath: path.join(root, "workspace"), ...options });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-dispatch-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placementStore = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reports every durable startup transition without letting reporting break dispatch", async () => {
    const harness = createTestHarness();
    const states: string[] = [];

    const placement = await harness.service.dispatch(REQUEST, (current) => {
      states.push(current.state);
      throw new Error("reporting failed");
    });

    expect(placement.state).toBe("active");
    expect(states).toEqual(["requested", "provisioning", "syncing", "starting", "active"]);
  });

  it("provisions an inherited dispatch from the exact durable profile snapshot", async () => {
    const harness = createTestHarness();
    const inheritedProfile = {
      providerId: "fake",
      profileSnapshot: { install: "bundle" as const, settings: { region: "parent" } },
    };

    await harness.service.dispatch({ ...REQUEST, inheritedProfile, machineClass: "beast" });

    expect(harness.environments.create).not.toHaveBeenCalled();
    expect(harness.environments.createFromProfileSnapshot).toHaveBeenCalledWith(
      { profileId: REQUEST.profileId, ...inheritedProfile },
      expect.stringMatching(/^session-dispatch:/u),
      "beast",
      REQUEST.executionMode,
    );
  });

  it("reports the final durable placement after startup failure teardown", async () => {
    const harness = createTestHarness({ failAt: "sync" });
    const states: string[] = [];

    await expect(
      harness.service.dispatch(REQUEST, (placement) => states.push(placement.state)),
    ).rejects.toThrow("sync failed");

    expect(states).toEqual(["requested", "provisioning", "syncing", "failed"]);
    expect(harness.environments.stopTunnel).toHaveBeenCalledWith(
      harness.attached.environmentId,
      harness.attached.ownerEpoch,
    );
  });

  it("recovers a completed turn's durable pending workspace result before stale-claim teardown", async () => {
    const publicationOrder: string[] = [];
    const prepareAcceptedWorkspacePublication = vi.fn(async (claim) => {
      expect(
        placementStore
          .listPendingWorkspaceResults()
          .find((pending) => pending.claimId === claim.claimId)?.workspaceAcceptedAtMs,
      ).toBeNull();
      publicationOrder.push("prepare");
    });
    const publishAcceptedWorkspace = vi.fn(async () => {
      publicationOrder.push("publish");
    });
    const harness = createTestHarness({
      prepareAcceptedWorkspacePublication,
      publishAcceptedWorkspace,
    });
    const active = harness.placements.seedActive(2);
    harness.markEnvironmentOwnerEpoch(2);
    harness.markEnvironmentNodeDeviceId("completed-worker-node");
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

    const otherRequest = {
      ...REQUEST,
      sessionId: "session-2",
      sessionKey: "agent:main:session-2",
    };
    let otherPlacement = placementStore.startDispatch(otherRequest);
    otherPlacement = placementStore.transition({
      sessionId: otherRequest.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: otherPlacement.generation,
      patch: { environmentId: active.environmentId },
    });
    otherPlacement = placementStore.transition({
      sessionId: otherRequest.sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: otherPlacement.generation,
      patch: { workerBundleHash: active.workerBundleHash },
    });
    otherPlacement = placementStore.transition({
      sessionId: otherRequest.sessionId,
      from: "syncing",
      to: "starting",
      expectedGeneration: otherPlacement.generation,
      patch: {
        workspaceBaseManifestRef: active.workspaceBaseManifestRef,
        remoteWorkspaceDir: active.remoteWorkspaceDir,
      },
    });
    placementStore.transition({
      sessionId: otherRequest.sessionId,
      from: "starting",
      to: "active",
      expectedGeneration: otherPlacement.generation,
      patch: { activeOwnerEpoch: active.activeOwnerEpoch },
    });
    const otherClaim = placementStore.claimTurn({
      ...otherRequest,
      claimId: "other-session-claim",
      runId: "other-session-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    placementStore.markWorkspaceResultPending(otherClaim);

    await harness.service.reconcile();

    expect(prepareAcceptedWorkspacePublication).toHaveBeenCalledWith(claim);
    expect(publishAcceptedWorkspace).toHaveBeenCalledWith(claim);
    expect(publicationOrder).toEqual(["prepare", "publish"]);
    expect(harness.placements.current()).toMatchObject({
      state: "active",
      turnClaim: null,
      workspaceBaseManifestRef: harness.reconciledManifestRef,
    });
    expect(placementStore.listPendingWorkspaceResults()).toMatchObject([
      { sessionId: otherRequest.sessionId, claimId: otherClaim.claimId },
    ]);
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });

  it("destroys and reclaims a pending result owned by a previous gateway instance", async () => {
    const originalHarness = createTestHarness();
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
    const restartedHarness = createTestHarness({}, restartedStore);
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

  it("keeps a previous-instance pending result fenced when another session is attached", async () => {
    const originalHarness = createTestHarness();
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
    const restartedHarness = createTestHarness({}, restartedStore);
    restartedHarness.markEnvironmentAttachments([REQUEST.sessionId, "session-2"]);
    await restartedHarness.service.reconcile();

    expect(restartedHarness.placements.current()).toMatchObject({
      state: "active",
      turnClaim: { claimId: claim.claimId },
    });
    expect(restartedStore.listPendingWorkspaceResults()).toHaveLength(1);
    expect(restartedHarness.environments.destroy).not.toHaveBeenCalled();
  });

  it("recovers a draining turn result using the admitted claim generation", async () => {
    const harness = createTestHarness();
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
    const harness = createTestHarness({ resumeFails: true });
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
  });

  it("fails a pending result with diagnostics when its worker is proven lost", async () => {
    const harness = createTestHarness();
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
    const publishAcceptedWorkspace = vi.fn(async () => undefined);
    const harness = createTestHarness({ publishAcceptedWorkspace });
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
    expect(publishAcceptedWorkspace).toHaveBeenCalledWith(claim);
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
  });

  it("coalesces overlapping reclaim requests and accepts completed retries", async () => {
    const harness = createTestHarness();
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

  it("keeps the worker draining when inbound workspace reconciliation conflicts", async () => {
    const harness = createTestHarness({ reconcileFails: true });
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      }),
    ).rejects.toThrow("workspace conflict");

    expect(harness.placements.current()).toMatchObject({ state: "draining" });
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(harness.log).toContain("workspace:resume");
  });

  it("keeps the worker draining when the remote workspace changes after local acceptance", async () => {
    const harness = createTestHarness({ verifyFails: true });
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      }),
    ).rejects.toThrow("workspace changed after reconciliation");

    expect(harness.placements.current()).toMatchObject({
      state: "draining",
      workspaceBaseManifestRef: harness.reconciledManifestRef,
    });
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(harness.log).toContain("workspace:resume");
  });

  it("keeps the worker draining when its quiescence lease expires", async () => {
    const harness = createTestHarness({ leaseFails: true });
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

  it("keeps the worker draining when the accepted local result changes", async () => {
    const harness = createTestHarness({ localVerifyFails: true });
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

  it("keeps the accepted placement draining when provider destruction is not proven", async () => {
    const harness = createTestHarness({ destroyFails: true });
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      }),
    ).rejects.toThrow("destroy pending");

    expect(harness.placements.current()).toMatchObject({
      state: "draining",
      workspaceBaseManifestRef: harness.reconciledManifestRef,
      turnClaim: null,
    });
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
    expect(harness.log).toContain("placement:draining");
    expect(harness.log).toContain("workspace:resume");
  });

  it("recovers a failed provider destroy and allows a normal local reclaim", async () => {
    const harness = createTestHarness({
      destroyFailureCount: 1,
      destroyFailureState: "destroying",
      resumeFails: true,
    });
    const active = await harness.service.dispatch(REQUEST);

    await expect(harness.service.reclaim(REQUEST)).rejects.toThrow("destroy pending");

    expect(harness.environments.get(active.environmentId)).toMatchObject({
      state: "destroyed",
    });
    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      turnClaim: null,
    });
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
    expect(harness.environments.destroy).toHaveBeenCalledTimes(2);
    expect(harness.log).not.toContain("workspace:resume");

    await expect(harness.service.reclaim(REQUEST)).resolves.toMatchObject({ state: "local" });
    expect(harness.environments.destroy).toHaveBeenCalledTimes(2);
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
    const harness = createTestHarness({ failAt });

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

  it("rejects workspace preflight before allocation and allows a corrected redispatch", async () => {
    const rejectedHarness = createTestHarness({ failAt: "preflight" });

    await expect(rejectedHarness.service.dispatch(REQUEST)).rejects.toMatchObject({
      code: "invalid_state",
      message: "preflight failed",
    });

    expect(rejectedHarness.placements.current()).toBeUndefined();
    expect(rejectedHarness.log).toEqual(["barrier", "preflight"]);
    expect(rejectedHarness.environments.create).not.toHaveBeenCalled();

    const correctedHarness = createTestHarness();
    const active = await correctedHarness.service.dispatch(REQUEST);

    expect(active.state).toBe("active");
    expect(correctedHarness.log.indexOf("preflight")).toBeLessThan(
      correctedHarness.log.indexOf("placement:requested"),
    );
  });

  it.each(["requested", "syncing"] as const)(
    "allows explicit redispatch after restart recovery fails an interrupted %s placement",
    async (interruptedState) => {
      let interrupted = placementStore.startDispatch(REQUEST);
      if (interruptedState !== "requested") {
        interrupted = placementStore.transition({
          sessionId: REQUEST.sessionId,
          from: "requested",
          to: "provisioning",
          expectedGeneration: interrupted.generation,
          patch: {
            environmentId: deriveEnvironmentIntent(
              `session-dispatch:${REQUEST.sessionId}:${interrupted.generation}`,
            ).environmentId,
          },
        });
      }
      if (interruptedState === "syncing") {
        interrupted = placementStore.transition({
          sessionId: REQUEST.sessionId,
          from: "provisioning",
          to: "syncing",
          expectedGeneration: interrupted.generation,
          patch: { workerBundleHash: "a".repeat(64) },
        });
      }
      const interruptedEnvironmentId = interrupted.environmentId;
      const restartedHarness = createTestHarness();

      await restartedHarness.service.reconcile();
      const failed = restartedHarness.placements.current();
      expect(failed).toMatchObject({
        state: "failed",
        recoveryError: `Worker dispatch interrupted in ${interruptedState}`,
      });
      if (failed?.state !== "failed") {
        throw new Error("restart recovery did not fail the interrupted placement");
      }
      const environmentOwned = interruptedState !== "requested";
      expect(restartedHarness.environments.stopTunnel).toHaveBeenCalledTimes(
        environmentOwned ? 1 : 0,
      );
      expect(restartedHarness.environments.destroy).toHaveBeenCalledTimes(environmentOwned ? 1 : 0);
      const redispatchHarness = createTestHarness({
        environmentGeneration: failed.generation + 1,
      });

      const active = await redispatchHarness.service.dispatch(REQUEST);

      expect(active).toMatchObject({
        state: "active",
        environmentId: redispatchHarness.ready.environmentId,
      });
      expect(active.generation).toBeGreaterThan(failed.generation);
      expect(active.environmentId).not.toBe(interruptedEnvironmentId);
      expect(redispatchHarness.log).toContain("placement:requested");
    },
  );

  it("tears down the attached owner after restart interrupts workspace sync", async () => {
    const harness = createTestHarness();
    const interrupted = seedSyncingPlacement(placementStore, harness.attached.environmentId);
    harness.markEnvironmentOwnerEpoch(harness.attached.ownerEpoch);

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: "Worker dispatch interrupted in syncing",
    });
    expect(harness.environments.attachSession).not.toHaveBeenCalled();
    expect(harness.environments.stopTunnel).toHaveBeenCalledWith(
      interrupted.environmentId,
      undefined,
    );
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("does not fail or tear down a dispatch owned by another invocation", async () => {
    placementStore.startDispatch(REQUEST);
    const harness = createTestHarness();

    await expect(harness.service.dispatch(REQUEST)).rejects.toThrow(
      "Cannot dispatch session session-1 from placement requested",
    );

    expect(harness.placements.current()).toMatchObject({ state: "requested" });
    expect(harness.log).not.toContain("placement:failed");
    expect(harness.log).not.toContain("teardown:destroy");
  });

  it("rejects and tears down a freshly provisioned bundle without execution context", async () => {
    const harness = createTestHarness();
    harness.markEnvironmentProtocolFeatures(["worker-execution-context-v1"]);

    await expect(harness.service.dispatch(REQUEST)).rejects.toThrow(
      "current worker launch contract",
    );

    expect(harness.placements.current()).toMatchObject({ state: "failed" });
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("persists pending teardown evidence after placement is fenced", async () => {
    const harness = createTestHarness({ failAt: "sync", destroyFails: true });

    await expect(harness.service.dispatch(REQUEST)).rejects.toThrow("sync failed");

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: expect.stringContaining("environment destroy: destroy pending"),
    });
    expect(harness.log.filter((entry) => entry === "placement:failed")).toHaveLength(1);
  });

  it("adopts an exact active environment after restart without reprovisioning", async () => {
    const harness = createTestHarness();
    await harness.environments.attachSession({
      environmentId: harness.ready.environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    harness.placements.seedActive(harness.attached.ownerEpoch, "remote-exec");
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

  it("reclaims an active worker missing execution context instead of adopting it", async () => {
    const harness = createTestHarness();
    await harness.environments.attachSession({
      environmentId: harness.ready.environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    harness.placements.seedActive(harness.attached.ownerEpoch);
    harness.markEnvironmentProtocolFeatures([WORKER_LAUNCH_V2_PROTOCOL_FEATURE]);

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({ state: "reclaimed" });
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("fails an active placement whose environment disappeared before restart", async () => {
    const harness = createTestHarness();
    harness.placements.seedActive(harness.attached.ownerEpoch);
    harness.markEnvironmentFailed();
    harness.log.length = 0;

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      environmentId: harness.ready.environmentId,
      activeOwnerEpoch: harness.attached.ownerEpoch,
      recoveryError:
        "cloud worker disappeared: Worker environment disappeared before teardown was requested",
      terminalReason:
        "cloud worker disappeared: Worker environment disappeared before teardown was requested",
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
    const harness = createTestHarness();
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
    const harness = createTestHarness();
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

  it("fails closed instead of activating a synced placement after restart", async () => {
    const harness = createTestHarness();
    harness.placements.seedStarting();
    harness.log.length = 0;

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      environmentId: harness.ready.environmentId,
      recoveryError: "Worker dispatch interrupted in starting",
    });
    expect(harness.environments.attachSession).not.toHaveBeenCalled();
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("tears down an attached starting placement after restart loses request authority", async () => {
    const harness = createTestHarness();
    harness.placements.seedStarting();
    harness.markEnvironmentOwnerEpoch(harness.attached.ownerEpoch);
    harness.log.length = 0;

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      environmentId: harness.attached.environmentId,
      recoveryError: "Worker dispatch interrupted in starting",
    });
    expect(harness.environments.attachSession).not.toHaveBeenCalled();
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("tears down a starting worker missing execution context instead of resuming it", async () => {
    const harness = createTestHarness();
    harness.placements.seedStarting();
    harness.markEnvironmentProtocolFeatures([WORKER_LAUNCH_V2_PROTOCOL_FEATURE]);

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: "Worker dispatch interrupted in starting",
    });
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("finishes an interrupted drain through reconciliation before failure", async () => {
    const harness = createTestHarness();
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
    const harness = createTestHarness();
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
    const harness = createTestHarness();
    await harness.environments.attachSession({
      environmentId: harness.ready.environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    harness.placements.seedActive(harness.attached.ownerEpoch);
    harness.markEnvironmentNodeDeviceId("live-worker-node");
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
    const harness = createTestHarness();
    await harness.environments.attachSession({
      environmentId: harness.ready.environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    harness.placements.seedActive(harness.attached.ownerEpoch);
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "claim-1",
      runId: "run-1",
      owner: {
        kind: "worker",
        environmentId: harness.attached.environmentId,
        ownerEpoch: harness.attached.ownerEpoch,
      },
    });
    const binding = claim;
    placementStore.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    expect(
      placementStore.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_send",
        toolCallId: "call-owner-mismatch",
        requestDigest: "digest-owner-mismatch",
      }),
    ).toMatchObject({ kind: "execute" });
    harness.markEnvironmentOwnerEpoch(harness.attached.ownerEpoch + 1);
    harness.log.length = 0;

    const reconciliation = harness.service.reconcileActive();

    await vi.waitFor(() => {
      expect(placementStore.isWorkerTurnToolAuthorized(binding, "sessions_send")).toBe(false);
    });
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(harness.placements.current()).toMatchObject({
      state: "draining",
      turnClaim: { claimId: claim.claimId },
    });
    expect(
      placementStore.completeWorkerSessionToolOperation({
        sourceSessionId: claim.sessionId,
        sourceClaimId: claim.claimId,
        toolCallId: "call-owner-mismatch",
        requestDigest: "digest-owner-mismatch",
        resultJson: '{"status":"ok"}',
      }),
    ).toBe(true);
    await reconciliation;

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

  it("fails an active placement when its environment disappears", async () => {
    const harness = createTestHarness();
    harness.placements.seedActive(harness.attached.ownerEpoch);
    harness.markEnvironmentFailed();
    harness.log.length = 0;

    await harness.service.reconcileActive();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError:
        "cloud worker disappeared: Worker environment disappeared before teardown was requested",
      terminalReason:
        "cloud worker disappeared: Worker environment disappeared before teardown was requested",
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
    const harness = createTestHarness();
    harness.placements.seedActive(harness.attached.ownerEpoch);
    harness.markEnvironmentFailed();
    harness.log.length = 0;

    await harness.service.reconcileActive("worker-other");

    expect(harness.placements.current()).toMatchObject({ state: "active" });
    expect(harness.log).toEqual(["environment:reconcile"]);

    await harness.service.reconcileActive(harness.ready.environmentId);

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError:
        "cloud worker disappeared: Worker environment disappeared before teardown was requested",
    });
  });

  it("does not retry unrelated failed teardown during requested reconciliation", async () => {
    const harness = createTestHarness({ failAt: "sync", destroyFails: true });
    await expect(harness.service.dispatch(REQUEST)).rejects.toThrow("sync failed");
    harness.log.length = 0;
    vi.mocked(harness.environments.destroy).mockClear();

    await harness.service.reconcileActive("worker-other");

    expect(harness.placements.current()).toMatchObject({ state: "failed" });
    expect(harness.log).toEqual(["environment:reconcile"]);
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });

  it("fences a turn admitted immediately before runtime drain", async () => {
    const harness = createTestHarness({ claimOnDrain: true });
    harness.placements.seedActive(harness.attached.ownerEpoch);
    harness.markEnvironmentFailed();
    harness.log.length = 0;

    await harness.service.reconcileActive();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      turnClaim: null,
      recoveryError:
        "cloud worker disappeared: Worker environment disappeared before teardown was requested",
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
    const harness = createTestHarness();
    harness.placements.seedStarting();
    harness.log.length = 0;

    await harness.service.reconcileActive();

    expect(harness.placements.current()).toMatchObject({ state: "starting" });
    expect(harness.log).toEqual(["environment:reconcile"]);
    expect(harness.environments.attachSession).not.toHaveBeenCalled();
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });
});
