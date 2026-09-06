import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import {
  BUNDLE_HASH,
  MANIFEST_REF,
  type PlacementStore,
  REQUEST,
} from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerPlacementMoveService } from "./placement-move-service.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { prepareSessionWorkerPlacementStop } from "./session-placement-lifecycle.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("worker placement dispatch reclaim", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let placementStore: PlacementStore;

  beforeEach(async () => {
    root = tempDirs.make("openclaw-dispatch-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placementStore = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("releases a failed reclaim before an older provisioning recovery without losing accepted work", async () => {
    const harness = createHarness(placementStore, {
      workspacePath: root,
      destroyFailureCount: 1,
      reconcileChanged: false,
      reconcileCommitsManifest: false,
    });
    const coordinated = coordinateWorkerPlacementDispatch(harness.service, (_request, run) =>
      run(),
    );
    const provisionStarted = createDeferredCore();
    const releaseProvision = createDeferredCore();
    vi.mocked(harness.environments.create).mockImplementationOnce(async () => {
      provisionStarted.resolve();
      await releaseProvision.promise;
      return harness.ready;
    });
    const dispatching = coordinated.dispatch(REQUEST);
    await provisionStarted.promise;
    const provisioning = placementStore.get(REQUEST.sessionId);
    if (provisioning?.state !== "provisioning") {
      throw new Error("expected in-flight provisioning owner");
    }
    const reclaiming = coordinated.reclaim(REQUEST);
    const outcome = reclaiming.catch((error: unknown) => error);
    const olderRecovery = coordinated.resumeProvisioning(provisioning, async () => {});
    // The environment service joins the pass already waiting behind reclaim.
    vi.mocked(harness.environments.reconcileOnce).mockImplementationOnce(async () => {
      await olderRecovery;
    });
    releaseProvision.resolve();
    await dispatching;
    expect(await outcome).toEqual(new Error("destroy pending"));
    await olderRecovery;
    expect(placementStore.get(REQUEST.sessionId)?.state).toBe("draining");
    expect(placementStore.listPendingWorkspaceResults()).toEqual([
      expect.objectContaining({ workspaceAcceptedAtMs: expect.any(Number) }),
    ]);
    expect(harness.log.filter((event) => event === "workspace:reconcile")).toHaveLength(1);

    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("keeps the accepted placement draining when provider destruction is not proven", async () => {
    const harness = createHarness(placementStore, {
      workspacePath: path.join(root, "workspace"),
      destroyFails: true,
    });
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      }),
    ).rejects.toThrow("destroy pending");

    expect(placementStore.listPendingWorkspaceResults()).toEqual([
      expect.objectContaining({ workspaceAcceptedAtMs: expect.any(Number) }),
    ]);
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
    await harness.service.reconcileActive();

    expect(harness.placements.current()).toMatchObject({
      state: "draining",
      workspaceBaseManifestRef: harness.reconciledManifestRef,
      turnClaim: null,
    });
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
    expect(harness.log).toContain("placement:draining");
    expect(harness.log).toContain("workspace:resume");
  });

  it("attaches before opening one tunnel for workspace sync and activation", async () => {
    const harness = createHarness(placementStore);

    await expect(harness.service.dispatch(REQUEST)).resolves.toMatchObject({
      state: "active",
      environmentId: harness.ready.environmentId,
      activeOwnerEpoch: 2,
      workspaceBaseManifestRef: MANIFEST_REF,
      remoteWorkspaceDir: "/worker/workspace",
      workerBundleHash: BUNDLE_HASH,
    });

    expect(harness.log).toEqual([
      "barrier",
      "placement:requested",
      "workspace",
      "placement:provisioning",
      "create",
      "placement:syncing",
      "attach",
      "tunnel:attached",
      "sync",
      "placement:starting",
      "activation",
      "placement:active",
    ]);
    expect(harness.environments.startTunnel).toHaveBeenCalledOnce();
  });

  it("reclaims an unchanged active placement through the fenced teardown lifecycle", async () => {
    const harness = createHarness(placementStore, {
      reconcileChanged: false,
      reconcileCommitsManifest: false,
    });
    await expect(harness.service.dispatch(REQUEST)).resolves.toMatchObject({
      state: "active",
      turnClaim: null,
      workspaceBaseManifestRef: MANIFEST_REF,
    });

    await expect(
      harness.service.reclaim({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      }),
    ).resolves.toMatchObject({
      state: "reclaimed",
      turnClaim: null,
      workspaceBaseManifestRef: MANIFEST_REF,
    });

    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
    expect(harness.log.slice(-13)).toEqual([
      "placement:draining",
      "tunnel:attached",
      "workspace:quiesce",
      "workspace:reconcile",
      "workspace:verify",
      "workspace:verify-local",
      "workspace:lease",
      "workspace:verify",
      "workspace:verify-local",
      "teardown:destroy",
      "placement:reconciling",
      "placement:reclaimed",
      "teardown:stop",
    ]);
  });

  it("moves an active placement back to the Gateway without a reclaimed intermediate", async () => {
    const harness = createHarness(placementStore, {
      reconcileChanged: false,
      reconcileCommitsManifest: false,
    });
    const active = await harness.service.dispatch(REQUEST);
    database.db
      .prepare(
        `INSERT INTO worker_environments (
          environment_id, provider_id, profile_id, profile_snapshot_json,
          provision_operation_id, lease_id, state, owner_epoch,
          attached_session_ids_json, created_at_ms, updated_at_ms, state_changed_at_ms
        ) VALUES (?, 'test', ?, '{}', ?, 'lease-move', 'attached', ?, ?, 1000, 1000, 1000)`,
      )
      .run(
        active.environmentId,
        REQUEST.profileId,
        `provision:${active.environmentId}`,
        active.activeOwnerEpoch,
        JSON.stringify([active.sessionId]),
      );

    await expect(
      harness.service.move({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
        source: {
          generation: active.generation,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
        target: { kind: "gateway" },
      }),
    ).resolves.toMatchObject({
      state: "local",
      environmentId: null,
      activeOwnerEpoch: null,
    });

    expect(harness.log).toContain("placement:draining");
    expect(harness.log).toContain("placement:reconciling");
    expect(harness.log).not.toContain("placement:reclaimed");
    expect(placementStore.getPlacementMove(REQUEST.sessionId)).toBeUndefined();
  });

  it("carries session authorization from move source teardown into destination dispatch", async () => {
    const harness = createHarness(placementStore, {
      reconcileChanged: false,
      reconcileCommitsManifest: false,
    });
    const active = await harness.service.dispatch(REQUEST);
    database.db
      .prepare(
        `INSERT INTO worker_environments (
          environment_id, provider_id, profile_id, profile_snapshot_json,
          provision_operation_id, lease_id, state, owner_epoch,
          attached_session_ids_json, created_at_ms, updated_at_ms, state_changed_at_ms
        ) VALUES (?, 'test', ?, '{}', ?, 'lease-move-auth', 'attached', ?, ?, 1000, 1000, 1000)`,
      )
      .run(
        active.environmentId,
        REQUEST.profileId,
        `provision:${active.environmentId}`,
        active.activeOwnerEpoch,
        JSON.stringify([active.sessionId]),
      );
    let authorizationChecks = 0;
    const authorize = vi.fn(() => {
      authorizationChecks += 1;
      if (authorizationChecks === 3) {
        throw new Error("session access revoked");
      }
    });
    const destinationDispatch = vi.fn(
      async (
        _request: Parameters<ReturnType<typeof createHarness>["service"]["dispatch"]>[0],
        _onTransition: Parameters<ReturnType<typeof createHarness>["service"]["dispatch"]>[1],
        destinationAuthorize: Parameters<
          ReturnType<typeof createHarness>["service"]["dispatch"]
        >[2],
      ) => {
        destinationAuthorize?.();
        throw new Error("destination dispatch lost authorization");
      },
    );
    const service = createWorkerPlacementMoveService({
      placements: placementStore,
      environments: { get: () => undefined },
      runMoveBarrier: async ({ authorize: sourceAuthorize, begin }) => {
        sourceAuthorize?.();
        return begin();
      },
      dispatch: destinationDispatch,
      reclaimSource: async (_request, intent, sourceAuthorize) => {
        sourceAuthorize?.();
        const draining = placementStore.get(intent.sessionId);
        if (draining?.state !== "draining") {
          throw new Error("move source did not enter draining state");
        }
        const reconciling = placementStore.startReconcile({
          sessionId: draining.sessionId,
          environmentId: draining.environmentId,
          ownerEpoch: draining.activeOwnerEpoch,
          expectedGeneration: draining.generation,
        });
        const local = placementStore.completePlacementMoveSourceToLocal({
          operationId: intent.operationId,
          sessionId: intent.sessionId,
          expectedGeneration: reconciling.generation,
        });
        if (local.state !== "local") {
          throw new Error("move source did not return to local state");
        }
        return local;
      },
      validateAbandonSource: vi.fn(),
      abandonSource: vi.fn(async () => {
        throw new Error("unexpected source abandonment");
      }),
      resolveDestination: async () => ({
        profileId: "destination-profile",
        executionMode: REQUEST.executionMode,
      }),
    });

    await expect(
      service.move(
        {
          sessionId: active.sessionId,
          sessionKey: active.sessionKey,
          agentId: active.agentId,
          source: {
            generation: active.generation,
            environmentId: active.environmentId,
            ownerEpoch: active.activeOwnerEpoch,
          },
          target: { kind: "profile", profileId: "destination-profile" },
        },
        undefined,
        authorize,
      ),
    ).rejects.toThrow("session access revoked");

    expect(authorize).toHaveBeenCalledTimes(3);
    expect(destinationDispatch).toHaveBeenCalledOnce();
    expect(placementStore.get(active.sessionId)).toMatchObject({ state: "local" });
  });

  it("recovers a durable Gateway move intent before generic draining recovery", async () => {
    const harness = createHarness(placementStore, {
      reconcileChanged: false,
      reconcileCommitsManifest: false,
      failMoveAfterBegin: true,
    });
    const active = await harness.service.dispatch(REQUEST);
    database.db
      .prepare(
        `INSERT INTO worker_environments (
          environment_id, provider_id, profile_id, profile_snapshot_json,
          provision_operation_id, lease_id, state, owner_epoch,
          attached_session_ids_json, created_at_ms, updated_at_ms, state_changed_at_ms
        ) VALUES (?, 'test', ?, '{}', ?, 'lease-move-recovery', 'attached', ?, ?, 1000, 1000, 1000)`,
      )
      .run(
        active.environmentId,
        REQUEST.profileId,
        `provision:${active.environmentId}`,
        active.activeOwnerEpoch,
        JSON.stringify([active.sessionId]),
      );

    await expect(
      harness.service.move({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
        source: {
          generation: active.generation,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
        target: { kind: "gateway" },
      }),
    ).rejects.toThrow("move barrier interrupted");
    expect(placementStore.get(active.sessionId)).toMatchObject({ state: "draining" });
    expect(placementStore.getPlacementMove(active.sessionId)).toMatchObject({
      target: { kind: "gateway" },
      lastError: "move barrier interrupted",
    });

    const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    const restarted = createHarness(restartedStore, {
      reconcileChanged: false,
      reconcileCommitsManifest: false,
    });
    restarted.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);
    await restarted.service.reconcile();

    expect(restartedStore.get(active.sessionId)).toMatchObject({ state: "local" });
    expect(restartedStore.getPlacementMove(active.sessionId)).toBeUndefined();
  });

  it("completes a restarted pending result through its Gateway move intent", async () => {
    const workspacePath = path.join(root, "pending-gateway-move");
    const harness = createHarness(placementStore, { workspacePath });
    const active = await harness.service.dispatch(REQUEST);
    database.db
      .prepare(
        `INSERT INTO worker_environments (
          environment_id, provider_id, profile_id, profile_snapshot_json,
          provision_operation_id, lease_id, state, owner_epoch,
          attached_session_ids_json, created_at_ms, updated_at_ms, state_changed_at_ms
        ) VALUES (?, 'test', ?, '{}', ?, 'lease-pending-move', 'attached', ?, ?, 1000, 1000, 1000)`,
      )
      .run(
        active.environmentId,
        REQUEST.profileId,
        `provision:${active.environmentId}`,
        active.activeOwnerEpoch,
        JSON.stringify([active.sessionId]),
      );
    const claim = placementStore.claimTurn({
      sessionId: active.sessionId,
      sessionKey: active.sessionKey,
      agentId: active.agentId,
      claimId: "pending-move-claim",
      runId: "pending-move-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    const begun = placementStore.beginPlacementMove({
      sessionId: active.sessionId,
      source: {
        generation: active.generation,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      target: { kind: "gateway" },
    });
    expect(begun.placement).toMatchObject({ state: "draining" });
    placementStore.markWorkspaceResultPending(claim);

    const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    const restarted = createHarness(restartedStore, { workspacePath });
    restarted.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);
    await restarted.service.reconcile();

    expect(restartedStore.get(active.sessionId)).toMatchObject({ state: "local" });
    expect(restartedStore.getPlacementMove(active.sessionId)).toBeUndefined();
    expect(restarted.log).not.toContain("placement:reclaimed");
  });

  it.each([false, true])(
    "serializes concurrent failed reclaim back to local (coordinated=%s)",
    async (coordinated) => {
      const harness = createHarness(placementStore);
      const requested = placementStore.startDispatch(REQUEST);
      const failed = placementStore.fail({
        sessionId: REQUEST.sessionId,
        expectedGeneration: requested.generation,
        recoveryError: "device worker is offline",
      });

      const service = coordinated
        ? coordinateWorkerPlacementDispatch(harness.service, (_request, run) => run())
        : harness.service;
      const results = await Promise.all([service.reclaim(REQUEST), service.reclaim(REQUEST)]);
      expect(results[1]).toEqual(results[0]);
      expect(results[0]).toMatchObject({
        state: "local",
        generation: failed.generation + 1,
        environmentId: null,
        recoveryError: null,
        terminalReason: null,
        terminalAtMs: null,
      });

      expect(harness.environments.startTunnel).not.toHaveBeenCalled();
      expect(harness.environments.destroy).not.toHaveBeenCalled();
    },
  );

  it("retries pending failed-environment teardown before clearing the placement", async () => {
    const harness = createHarness(placementStore, {
      failAt: "sync",
      destroyFails: true,
      destroyFailureState: "destroying",
    });
    await expect(harness.service.dispatch(REQUEST)).rejects.toThrow("sync failed");
    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: expect.stringContaining("environment destroy: destroy pending"),
    });

    const cleanupError = "release is pending; retry after provider cleanup advances";
    vi.mocked(harness.environments.destroy).mockRejectedValueOnce(new Error(cleanupError));
    await expect(harness.service.reclaim(REQUEST)).rejects.toThrow(cleanupError);
    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      environmentId: harness.attached.environmentId,
    });
    expect(harness.environments.get(harness.attached.environmentId)).toMatchObject({
      state: "destroying",
    });

    vi.mocked(harness.environments.destroy).mockImplementationOnce(async () => {
      harness.markEnvironmentDestroyed();
      const destroyed = harness.environments.get(harness.attached.environmentId);
      if (!destroyed) {
        throw new Error("expected destroyed environment");
      }
      return destroyed;
    });
    await expect(
      harness.service.reclaim({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      }),
    ).resolves.toMatchObject({ state: "local" });
    expect(harness.environments.destroy).toHaveBeenCalledTimes(3);
  });

  it.each(["active", "failed"] as const)(
    "rejects %s reclaim before its first durable cleanup action when authorization changes",
    async (state) => {
      const harness = createHarness(placementStore);
      if (state === "active") {
        await harness.service.dispatch(REQUEST);
      } else {
        const requested = placementStore.startDispatch(REQUEST);
        placementStore.fail({
          sessionId: REQUEST.sessionId,
          expectedGeneration: requested.generation,
          recoveryError: "dispatch failed",
        });
      }
      const destroyCalls = vi.mocked(harness.environments.destroy).mock.calls.length;
      const authorizationError = new Error("session participation changed");

      await expect(
        harness.service.reclaim(
          {
            sessionId: REQUEST.sessionId,
            sessionKey: REQUEST.sessionKey,
            agentId: REQUEST.agentId,
          },
          () => {
            throw authorizationError;
          },
        ),
      ).rejects.toBe(authorizationError);

      expect(harness.placements.current()).toMatchObject({ state });
      expect(harness.environments.destroy).toHaveBeenCalledTimes(destroyCalls);
    },
  );

  it("retains and reports cloud versions that conflict during an idle reclaim", async () => {
    const harness = createHarness(placementStore, {
      reconcileConflictPaths: ["src/local.ts"],
    });
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      }),
    ).resolves.toMatchObject({ state: "reclaimed" });

    expect(harness.placements.current()).toMatchObject({
      state: "reclaimed",
      workspaceResultConflict: {
        paths: ["src/local.ts"],
        stagedResultRef: expect.stringMatching(/^refs\/openclaw\/worker-results\/reclaim-/u),
        totalCount: 1,
      },
    });

    expect(harness.reportWorkspaceResultConflict).toHaveBeenCalledWith({
      sessionId: REQUEST.sessionId,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
      paths: ["src/local.ts"],
      stagedResultRef: expect.stringMatching(/^refs\/openclaw\/worker-results\/reclaim-/u),
      totalCount: 1,
    });
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("reclaims an unchanged worker without clearing a retained keep-local conflict", async () => {
    const priorConflict = {
      paths: ["notes.md"],
      stagedResultRef: "refs/openclaw/worker-results/prior-conflict",
    };
    const harness = createHarness(placementStore, {
      priorWorkspaceResultConflict: priorConflict,
      reconcileChanged: false,
      reconcileCommitsManifest: false,
    });
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      }),
    ).resolves.toMatchObject({
      state: "reclaimed",
      workspaceBaseManifestRef: MANIFEST_REF,
    });

    expect(harness.placements.current()).toMatchObject({ workspaceResultConflict: priorConflict });
    expect(harness.reportWorkspaceResultConflict).not.toHaveBeenCalled();
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("retires only the exact unclaimed safe placement generation", () => {
    const claim = placementStore.claimTurn({
      ...REQUEST,
      owner: { kind: "local" },
      claimId: "retirement-claim",
      runId: "retirement-run",
    });
    expect(() =>
      placementStore.retireSessionPlacement({
        sessionId: REQUEST.sessionId,
        expectedState: "local",
        expectedGeneration: 0,
      }),
    ).toThrow("changed before retirement");
    placementStore.releaseTurn(claim);
    placementStore.retireSessionPlacement({
      sessionId: REQUEST.sessionId,
      expectedState: "local",
      expectedGeneration: 0,
    });
    expect(placementStore.get(REQUEST.sessionId)).toBeUndefined();

    const requested = placementStore.startDispatch(REQUEST);
    const failed = placementStore.fail({
      sessionId: REQUEST.sessionId,
      expectedGeneration: requested.generation,
      recoveryError: "dispatch failed",
    });
    for (const stale of [
      { expectedState: "local" as const, expectedGeneration: 0 },
      { expectedState: "failed" as const, expectedGeneration: failed.generation - 1 },
    ]) {
      expect(() =>
        placementStore.retireSessionPlacement({ sessionId: REQUEST.sessionId, ...stale }),
      ).toThrow("changed before retirement");
    }
    expect(placementStore.get(REQUEST.sessionId)).toMatchObject({
      state: "failed",
      generation: failed.generation,
    });
  });

  it("retires a reclaimed placement with its child rows and conflict projection", () => {
    const harness = createHarness(placementStore);
    const active = harness.placements.seedActive(7);
    if (active.state !== "active") {
      throw new Error("expected active worker placement");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "retirement-worker-claim",
      runId: "retirement-worker-run",
    });
    placementStore.recordWorkspaceResultConflict(claim, {
      paths: ["conflicted.txt"],
      stagedResultRef: `refs/openclaw/worker-results/${claim.claimId}`,
    });
    placementStore.releaseTurn(claim);

    const basePack = Buffer.from("retirement workspace base pack");
    placementStore.beginWorkspaceReconciliation(
      {
        sessionId: active.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        placementGeneration: active.generation,
      },
      {
        version: 1,
        temporaryNonce: "c".repeat(32),
        baseManifestRef: active.workspaceBaseManifestRef,
        currentManifestRef: `sha256:${"d".repeat(64)}`,
        baseEntries: [],
        appliedEntries: [],
        baseTree: "e".repeat(40),
        basePackSha256: createHash("sha256").update(basePack).digest("hex"),
        basePack,
      },
    );
    const draining = placementStore.startDrain({
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    const reconciling = placementStore.startReconcile({
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: draining.generation,
    });
    const reclaimed = placementStore.transition({
      sessionId: active.sessionId,
      from: "reconciling",
      to: "reclaimed",
      expectedGeneration: reconciling.generation,
    });
    expect(placementStore.listWorkspaceReconciliationOwners()).toHaveLength(1);
    expect(placementStore.get(active.sessionId)?.workspaceResultConflict).toBeDefined();

    placementStore.retireSessionPlacement({
      sessionId: reclaimed.sessionId,
      expectedState: "reclaimed",
      expectedGeneration: reclaimed.generation,
    });

    expect(placementStore.get(active.sessionId)).toBeUndefined();
    expect(placementStore.listWorkspaceReconciliationOwners()).toEqual([]);
    placementStore.claimTurn({
      ...REQUEST,
      owner: { kind: "local" },
      claimId: "replacement-local-claim",
      runId: "replacement-local-run",
    });
    expect(placementStore.get(active.sessionId)).not.toHaveProperty("workspaceResultConflict");
  });

  it("applies a prepared staged result before requiring its manifest commit", async () => {
    const harness = createHarness(placementStore, {
      reconcileCommitsManifest: false,
      reconcileCommitsManifestOnApply: true,
    });
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      }),
    ).resolves.toMatchObject({
      state: "reclaimed",
      workspaceBaseManifestRef: harness.reconciledManifestRef,
    });

    expect(harness.log).toContain("workspace:apply-prepared");
  });

  it("claims and cancels a reclaim workspace result atomically", async () => {
    const harness = createHarness(placementStore);
    const active = await harness.service.dispatch(REQUEST);
    const claim = placementStore.claimReclaimWorkspaceResult({
      ...REQUEST,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "reclaim-atomic",
      runId: "reclaim-atomic",
    });

    expect(placementStore.get(active.sessionId)?.turnClaim).toMatchObject({
      claimId: claim.claimId,
    });
    expect(placementStore.listPendingWorkspaceResults()).toMatchObject([
      { sessionId: active.sessionId, claimId: claim.claimId },
    ]);

    expect(placementStore.cancelWorkspaceResultAndReleaseTurn(claim)).toMatchObject({
      turnClaim: null,
    });
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
  });

  it("releases a failed stop claim so reclaim can be retried", async () => {
    const workspacePath = path.join(root, "retry-workspace");
    await fs.mkdir(workspacePath);
    const initialized = await runCommandWithTimeout(
      ["git", "-C", workspacePath, "init", "--quiet"],
      { timeoutMs: 10_000 },
    );
    expect(initialized.code).toBe(0);
    const harness = createHarness(placementStore, {
      reconcileFailureCount: 1,
      workspacePath,
    });
    await harness.service.dispatch(REQUEST);
    const request = {
      sessionId: REQUEST.sessionId,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
    };

    await expect(harness.service.reclaim(request)).rejects.toThrow("workspace conflict");
    expect(harness.placements.current()).toMatchObject({ state: "draining", turnClaim: null });
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);

    await expect(harness.service.reclaim(request)).resolves.toMatchObject({ state: "reclaimed" });
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("rejects a replaced reclaimed owner after waiting to enter the lifecycle fence", async () => {
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const harness = createHarness(placementStore, {
      runReclaimBarrier: async ({ beforeDrain, begin, reclaim, authorize }) => {
        entered.resolve();
        await resume.promise;
        authorize?.();
        beforeDrain?.();
        const placement = begin();
        return placement.state === "reclaimed"
          ? placement
          : await reclaim("/gateway/workspace", placement, authorize);
      },
    });
    const active = await harness.service.dispatch(REQUEST);
    const stop = prepareSessionWorkerPlacementStop({
      ...REQUEST,
      action: "delete",
      context: {
        workerSessionPlacementService: placementStore,
        workerPlacementDispatchService: harness.service,
        workerEnvironmentService: harness.environments,
      },
    })();
    const rejected = expect(stop).rejects.toThrow("cloud worker placement identity changed");
    await entered.promise;
    try {
      const peer = createHarness(placementStore);
      peer.markEnvironmentOwnerEpoch(2);
      const reclaimed = await peer.service.reclaim(REQUEST);
      placementStore.retireSessionPlacement({
        sessionId: reclaimed.sessionId,
        expectedState: "reclaimed",
        expectedGeneration: reclaimed.generation,
      });
      const replacement = createHarness(placementStore, { environmentGeneration: 2 });
      replacement.placements.seedActive(2);
      replacement.markEnvironmentOwnerEpoch(2);
      const settled = await replacement.service.reclaim(REQUEST);
      expect(settled.environmentId).not.toBe(active.environmentId);
      resume.resolve();
      await rejected;
      expect(placementStore.get(REQUEST.sessionId)).toEqual(settled);
      expect(harness.environments.destroy).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await rejected;
    }
  });

  it("completes a session stop when a dropped tunnel loses the race to durable teardown", async () => {
    const harness = createHarness(placementStore, { terminalizeReclaimOnTunnelDrop: true });
    await harness.service.dispatch(REQUEST);

    const request = {
      sessionId: REQUEST.sessionId,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
    };
    const first = prepareSessionWorkerPlacementStop({
      ...request,
      action: "delete",
      context: {
        workerSessionPlacementService: placementStore,
        workerPlacementDispatchService: harness.service,
        workerEnvironmentService: harness.environments,
      },
    })();
    const coalesced = harness.service.reclaim(request);

    await expect(Promise.all([first, coalesced])).resolves.toMatchObject([
      undefined,
      { state: "reclaimed", turnClaim: null },
    ]);

    expect(harness.placements.current()).toMatchObject({ state: "reclaimed", turnClaim: null });
    expect(harness.environments.get(REQUEST.sessionId)).toMatchObject({ state: "destroyed" });
    expect(harness.log).toContain("teardown:destroy");
  });

  it("does not hide an unrelated failure after durable teardown", async () => {
    const harness = createHarness(placementStore, {
      terminalizeReclaimOnTunnelDrop: true,
      terminalizedReclaimError: new Error("credential rejected"),
    });
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      }),
    ).rejects.toThrow("credential rejected");
    expect(harness.placements.current()).toMatchObject({ state: "reclaimed", turnClaim: null });
  });

  it("releases a failed final-sync claim so reclaim with a retained conflict is retryable", async () => {
    const priorConflict = {
      paths: ["data.txt"],
      stagedResultRef: "refs/openclaw/worker-results/prior-conflict",
    };
    const harness = createHarness(placementStore, {
      priorWorkspaceResultConflict: priorConflict,
      reconcileChanged: false,
      leaseFailureCount: 1,
    });
    await harness.service.dispatch(REQUEST);
    const request = {
      sessionId: REQUEST.sessionId,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
    };

    await expect(harness.service.reclaim(request)).rejects.toThrow("workspace quiescence expired");
    expect(harness.placements.current()).toMatchObject({
      state: "draining",
      turnClaim: null,
    });
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);

    await expect(harness.service.reclaim(request)).resolves.toMatchObject({ state: "reclaimed" });
    expect(harness.placements.current()).toMatchObject({
      state: "reclaimed",
      workspaceResultConflict: priorConflict,
    });
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("keeps a changed result fenced when quiescence fails after apply", async () => {
    const harness = createHarness(placementStore, { leaseFailureCount: 1 });
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      }),
    ).rejects.toThrow("workspace quiescence expired");

    expect(harness.placements.current()).toMatchObject({
      state: "draining",
      turnClaim: { owner: "worker" },
    });
    expect(placementStore.listPendingWorkspaceResults()).toMatchObject([
      { workspaceAcceptedAtMs: null, stagedResultRef: null },
    ]);
  });

  it.each([1, 2])(
    "retries an unchanged result when final fence step %i observes a write",
    async (verifyFailureCall) => {
      const priorConflict = {
        paths: ["data.txt"],
        stagedResultRef: "refs/openclaw/worker-results/prior-conflict",
      };
      const harness = createHarness(placementStore, {
        priorWorkspaceResultConflict: priorConflict,
        reconcileChanged: false,
        verifyFailureCall,
      });
      await harness.service.dispatch(REQUEST);
      const request = {
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      };

      await expect(harness.service.reclaim(request)).rejects.toThrow(
        "workspace changed after reconciliation",
      );
      expect(harness.placements.current()).toMatchObject({ state: "draining", turnClaim: null });
      expect(placementStore.listPendingWorkspaceResults()).toEqual([]);

      await expect(harness.service.reclaim(request)).resolves.toMatchObject({ state: "reclaimed" });
      expect(harness.placements.current()).toMatchObject({
        state: "reclaimed",
        workspaceResultConflict: priorConflict,
      });
    },
  );

  it("keeps a committed failed stop result fenced for recovery", async () => {
    const priorConflict = {
      paths: ["notes.md"],
      stagedResultRef: "refs/openclaw/worker-results/prior-conflict",
    };
    const harness = createHarness(placementStore, {
      priorWorkspaceResultConflict: priorConflict,
      verifyFails: true,
    });
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
      turnClaim: { owner: "worker" },
    });
    expect(placementStore.listPendingWorkspaceResults()).toMatchObject([
      { workspaceAcceptedAtMs: null, stagedResultRef: null },
    ]);
  });

  it("a lifecycle owner can reclaim while another reclaim waits behind its fence", async () => {
    const scope = root;
    const queued = createDeferredCore();
    const locked = createDeferredCore();
    const resume = createDeferredCore();
    const identities = [REQUEST.sessionKey, REQUEST.sessionId];
    const harness = createHarness(placementStore, {
      reconcileChanged: false,
      reconcileCommitsManifest: false,
      runReclaimBarrier: async ({ authorize, beforeDrain, begin, reclaim }) => {
        queued.resolve();
        return await runExclusiveSessionLifecycleMutation({
          scope,
          identities,
          run: async () => {
            authorize?.();
            beforeDrain?.();
            const placement = begin();
            return placement.state === "reclaimed"
              ? placement
              : await reclaim(root, placement, authorize);
          },
        });
      },
    });
    await harness.service.dispatch(REQUEST);
    const owner = runExclusiveSessionLifecycleMutation({
      scope,
      identities,
      run: async () => {
        locked.resolve();
        await resume.promise;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            harness.service.reclaim(REQUEST),
            new Promise<"blocked">((resolve) => {
              timer = setTimeout(() => resolve("blocked"), 1_000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      },
    });
    await locked.promise;
    const competing = harness.service.reclaim(REQUEST);
    await queued.promise;
    resume.resolve();
    try {
      expect(await owner).toMatchObject({ state: "reclaimed" });
    } finally {
      await Promise.allSettled([owner, competing]);
    }
  });
});
