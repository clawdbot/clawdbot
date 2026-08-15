import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  BUNDLE_HASH,
  MANIFEST_REF,
  type PlacementStore,
  REQUEST,
} from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";

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
    expect(harness.log.slice(-11)).toEqual([
      "tunnel:attached",
      "workspace:quiesce",
      "workspace:reconcile",
      "workspace:verify",
      "workspace:verify-local",
      "workspace:lease",
      "workspace:verify",
      "workspace:verify-local",
      "teardown:destroy",
      "placement:reclaimed",
      "teardown:stop",
    ]);
  });

  it("reclaims an environment-free failed placement back to clean local state", async () => {
    const harness = createHarness(placementStore);
    const requested = placementStore.startDispatch(REQUEST);
    const failed = placementStore.fail({
      sessionId: REQUEST.sessionId,
      expectedGeneration: requested.generation,
      recoveryError: "device worker is offline",
    });

    await expect(
      harness.service.reclaim({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      }),
    ).resolves.toMatchObject({
      state: "local",
      generation: failed.generation + 1,
      environmentId: null,
      recoveryError: null,
      terminalReason: null,
      terminalAtMs: null,
    });

    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });

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
    const reclaimed = placementStore.finishReclaim({
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
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

  it.each(["pending result", "retained workspace journal"] as const)(
    "refuses to retire a failed placement with a %s owner",
    async (recoveryOwner) => {
      const harness = createHarness(placementStore);
      const active = harness.placements.seedActive(7);
      if (active.state !== "active") {
        throw new Error("expected active worker placement");
      }
      const owner = {
        sessionId: active.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        placementGeneration: active.generation,
      };
      let failed;
      if (recoveryOwner === "pending result") {
        const claim = placementStore.claimTurn({
          ...REQUEST,
          owner: {
            kind: "worker",
            environmentId: active.environmentId,
            ownerEpoch: active.activeOwnerEpoch,
          },
          claimId: "retirement-pending-claim",
          runId: "retirement-pending-run",
        });
        placementStore.markWorkspaceResultPending(claim);
        failed = await placementStore.failPendingWorkspaceResult({
          pending: placementStore.listPendingWorkspaceResults()[0]!,
          recoveryError: "workspace recovery requires operator action",
        });
      } else {
        const basePack = Buffer.from("retained retirement base pack");
        placementStore.beginWorkspaceReconciliation(owner, {
          version: 1,
          temporaryNonce: "c".repeat(32),
          baseManifestRef: active.workspaceBaseManifestRef,
          currentManifestRef: `sha256:${"d".repeat(64)}`,
          baseEntries: [],
          appliedEntries: [],
          baseTree: "e".repeat(40),
          basePackSha256: createHash("sha256").update(basePack).digest("hex"),
          basePack,
        });
        placementStore.retainWorkspaceReconciliationForForcedAbandonment(owner);
        const draining = placementStore.startDrain({
          sessionId: active.sessionId,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
          expectedGeneration: active.generation,
        });
        const reconciling = placementStore.startReconcile({
          sessionId: draining.sessionId,
          environmentId: draining.environmentId,
          ownerEpoch: draining.activeOwnerEpoch,
          expectedGeneration: draining.generation,
        });
        failed = placementStore.fail({
          sessionId: reconciling.sessionId,
          expectedGeneration: reconciling.generation,
          recoveryError: "workspace recovery requires operator action",
        });
      }

      expect(() =>
        placementStore.retireSessionPlacement({
          sessionId: failed.sessionId,
          expectedState: "failed",
          expectedGeneration: failed.generation,
        }),
      ).toThrow("must be force-abandoned before retirement");
      expect(placementStore.get(active.sessionId)).toMatchObject({ state: "failed" });
      expect(placementStore.listPendingWorkspaceResults().length).toBe(
        recoveryOwner === "pending result" ? 1 : 0,
      );
      expect(placementStore.listWorkspaceReconciliationOwners().length).toBe(
        recoveryOwner === "retained workspace journal" ? 1 : 0,
      );
    },
  );

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
    expect(harness.placements.current()).toMatchObject({ state: "active", turnClaim: null });
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);

    await expect(harness.service.reclaim(request)).resolves.toMatchObject({ state: "reclaimed" });
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("returns success when a dropped tunnel loses the race to durable teardown", async () => {
    const harness = createHarness(placementStore, { terminalizeReclaimOnTunnelDrop: true });
    await harness.service.dispatch(REQUEST);

    const request = {
      sessionId: REQUEST.sessionId,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
    };
    const first = harness.service.reclaim(request);
    const coalesced = harness.service.reclaim(request);

    await expect(Promise.all([first, coalesced])).resolves.toMatchObject([
      { state: "reclaimed", turnClaim: null },
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
      state: "active",
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
      state: "active",
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
      expect(harness.placements.current()).toMatchObject({ state: "active", turnClaim: null });
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
      state: "active",
      workspaceBaseManifestRef: harness.reconciledManifestRef,
      turnClaim: { owner: "worker" },
    });
    expect(placementStore.listPendingWorkspaceResults()).toMatchObject([
      { workspaceAcceptedAtMs: null, stagedResultRef: null },
    ]);
  });
});
