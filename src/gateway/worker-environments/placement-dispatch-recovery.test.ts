import { describe, expect, it, vi } from "vitest";
import type { WorkerInstallationArtifact } from "./bundle.js";
import { seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { createWorkerPlacementDispatchService } from "./placement-dispatch.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import * as support from "./service.test-support.js";
import type { WorkerTunnelManager } from "./tunnel.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

describe("worker placement restart recovery", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each(["bundle", "provider"] as const)(
    "keeps stale pending recovery fenced when %s recovery is unavailable",
    async (failure) => {
      let currentBundle: WorkerInstallationArtifact = support.BUNDLE_ARTIFACT;
      const recoveryState = { started: false };
      support.testState.prepareInstallation = vi.fn(async (install) => {
        if (install === "bundle" && recoveryState.started && failure === "bundle") {
          throw new Error("bundle unavailable");
        }
        return install === "bundle" ? currentBundle : support.NPM_ARTIFACT;
      });
      const tunnelManager = {
        status: () => "stopped" as const,
        start: vi.fn(),
        stop: vi.fn(async () => {}),
        stopAll: vi.fn(async () => {}),
      } as unknown as WorkerTunnelManager;
      const provider = support.createProvider({
        inspect: async () => {
          if (recoveryState.started && failure === "provider") {
            throw new Error("provider unavailable");
          }
          return { status: "active" };
        },
      });
      const workerService = support.createService(provider, { tunnelManager });
      const placements = createWorkerSessionPlacementStore({
        database: support.testState.stateDb,
        now: () => support.testState.nowMs,
      });
      const recovery = createWorkerPlacementDispatchService({
        placements,
        environments: workerService,
        workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
        runLocalBarrier: async ({ startDispatch }) => startDispatch(),
        runActivationBarrier: async ({ activate }) => activate(),
        runReclaimBarrier: async ({ reclaim }) => await reclaim("/gateway/workspace"),
        resolveWorkspacePath: async () => "/gateway/workspace",
        reportWorkspaceResultConflict: async () => {},
        resolveWorkspaceResultConflict: async () => undefined,
      });
      const environmentId = "worker-stale-recovery";
      support.seedReady(environmentId);
      const attached = await workerService.attachSession({
        environmentId,
        ownerEpoch: 1,
        sessionId: "session-1",
      });
      const active = seedActivePlacement(placements, {
        environmentId,
        ownerEpoch: attached.ownerEpoch,
      });
      if (active.state !== "active") {
        throw new Error("active placement fixture was not active");
      }
      const claim = placements.claimTurn({
        sessionId: active.sessionId,
        sessionKey: active.sessionKey,
        agentId: active.agentId,
        claimId: "claim-stale-recovery",
        runId: "run-stale-recovery",
        owner: {
          kind: "worker",
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
      });
      placements.markWorkspaceResultPending(claim);
      placements.handoffWorkspaceResultRecovery(claim);
      if (failure === "bundle") {
        currentBundle = { ...support.BUNDLE_ARTIFACT, bundleHash: "c".repeat(64) };
      }
      recoveryState.started = true;

      await recovery.reconcile();

      expect(placements.get(active.sessionId)).toMatchObject({
        state: "active",
        turnClaim: { claimId: claim.claimId, runId: claim.runId },
      });
      expect(placements.listPendingWorkspaceResults()).toHaveLength(1);
      expect(workerService.get(active.environmentId)).toMatchObject({
        state: "attached",
        destroyRequestedAtMs: null,
      });
      expect(tunnelManager.start).not.toHaveBeenCalled();
    },
  );
});
