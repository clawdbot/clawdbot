import fs from "node:fs/promises";
import os from "node:os";
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
    root = tempDirs.make("openclaw-dispatch-", await fs.realpath(os.tmpdir()));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placementStore = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("orders the migration barrier, provisioning, sync, attachment, and activation", async () => {
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
      "tunnel:ready",
      "sync",
      "placement:starting",
      "attach",
      "tunnel:attached",
      "activation",
      "placement:active",
    ]);
  });

  it("reconciles the workspace before destroying and reclaiming an active worker", async () => {
    const harness = createHarness(placementStore);
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
