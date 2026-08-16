import { describe, expect, it, vi } from "vitest";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import { seedActivePlacement, seedStartingPlacement } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerPlacementDispatchService } from "./placement-dispatch.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import type { WorkerTunnelManager } from "./tunnel.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

describe("worker placement restart recovery", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each(["active", "starting"] as const)(
    "retries a restarted %s placement after host isolation inspection recovers",
    async (state) => {
      const protocolFeatures = [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE];
      support.testState.prepareInstallation = vi.fn(async (install) => ({
        ...(install === "bundle" ? support.BUNDLE_ARTIFACT : support.NPM_ARTIFACT),
        protocolFeatures,
      }));
      let providerSharedHost = false;
      let recoveryStarted = false;
      const destroy = vi.fn(async () => {});
      const provider = support.createProvider({
        destroy,
        inspect: async () => {
          if (recoveryStarted) {
            throw new Error("provider unavailable");
          }
          return { status: "active", sharedHost: providerSharedHost };
        },
      });
      const tunnelManager = {
        status: () => "stopped" as const,
        start: vi.fn(async (request) => ({
          environmentId: request.environmentId,
          ownerEpoch: request.ownerEpoch,
          launchTurn: vi.fn(),
          quiesceWorkspace: vi.fn(),
          reconcileWorkspace: vi.fn(),
          runWorkspaceCommand: vi.fn(),
          stop: vi.fn(async () => {}),
          syncWorkspace: vi.fn(),
        })),
        stop: vi.fn(async () => {}),
        stopAll: vi.fn(async () => {}),
      } as unknown as WorkerTunnelManager;
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
      const environmentId = `worker-stale-isolation-${state}`;
      const bootstrapping = support.seedBootstrapping(environmentId, undefined, false);
      support.testState.store.transition({
        environmentId,
        from: bootstrapping.state,
        to: "ready",
        patch: support.readyPatch(environmentId, {
          ...support.BOOTSTRAP_RECEIPT,
          protocolFeatures,
        }),
      });
      if (state === "active") {
        const attached = await workerService.attachSession({
          environmentId,
          ownerEpoch: 1,
          sessionId: "session-1",
        });
        seedActivePlacement(placements, { environmentId, ownerEpoch: attached.ownerEpoch });
      } else {
        seedStartingPlacement(placements, environmentId);
      }
      expect(workerService.get(environmentId)?.sharedHost).toBe(false);
      const persisted = workerService.get(environmentId);
      if (!persisted?.leaseId) {
        throw new Error("worker recovery fixture has no provider lease");
      }
      support.testState.store.reconcileSharedHost({
        environmentId,
        state: persisted.state,
        leaseId: persisted.leaseId,
        sharedHost: null,
      });
      providerSharedHost = true;
      recoveryStarted = true;

      await recovery.reconcile();

      expect(placements.get("session-1")).toMatchObject({ state });
      expect(workerService.get(environmentId)?.sharedHost).toBeNull();
      expect(tunnelManager.start).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
      await expect(
        workerService.startTunnel({
          environmentId,
          ownerEpoch: workerService.get(environmentId)!.ownerEpoch,
        }),
      ).rejects.toThrow("isolation is not reconciled");

      recoveryStarted = false;
      await recovery.reconcileActive();
      if (state === "active") {
        await workerService.startTunnel({
          environmentId,
          ownerEpoch: workerService.get(environmentId)!.ownerEpoch,
        });
      }

      expect(placements.get("session-1")).toMatchObject({ state: "active" });
      expect(workerService.get(environmentId)?.sharedHost).toBe(true);
      expect(tunnelManager.start).toHaveBeenCalledOnce();
      expect(tunnelManager.start).toHaveBeenCalledWith(
        expect.objectContaining({ sharedHost: true }),
      );
      expect(destroy).not.toHaveBeenCalled();
    },
  );

  it("keeps stale pending recovery fenced when provider recovery is unavailable", async () => {
    const recoveryState = { started: false };
    const tunnelManager = {
      status: () => "stopped" as const,
      start: vi.fn(),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const provider = support.createProvider({
      inspect: async () => {
        if (recoveryState.started) {
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
  });

  it("keeps stale worker bundle recovery retryable through its installed workspace receiver", async () => {
    let currentBundle: WorkerInstallationArtifact = support.BUNDLE_ARTIFACT;
    support.testState.prepareInstallation = vi.fn(async (install) =>
      install === "bundle" ? currentBundle : support.NPM_ARTIFACT,
    );
    const tunnelManager = {
      status: () => "stopped" as const,
      start: vi.fn(async () => {
        throw new Error("SSH transport unavailable");
      }),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    const workerService = support.createService(support.createProvider(), {
      placementStore: createWorkerSessionPlacementGate(placements),
      tunnelManager,
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
    const environmentId = "worker-stale-bundle-recovery";
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
      claimId: "claim-stale-bundle-recovery",
      runId: "run-stale-bundle-recovery",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    placements.markWorkspaceResultPending(claim);
    placements.handoffWorkspaceResultRecovery(claim);
    currentBundle = { ...support.BUNDLE_ARTIFACT, bundleHash: "c".repeat(64) };
    const expiredCredential = support.testState.store.getCredential(environmentId);
    if (!expiredCredential) {
      throw new Error("worker recovery fixture has no credential");
    }
    support.testState.nowMs = expiredCredential.expiresAtMs + 1;

    await recovery.reconcile();

    expect(placements.get(active.sessionId)).toMatchObject({
      state: "active",
      turnClaim: { claimId: claim.claimId, runId: claim.runId },
    });
    expect(placements.get(active.sessionId)).not.toHaveProperty("terminalRecovery");
    expect(placements.listPendingWorkspaceResults()).toHaveLength(1);
    expect(workerService.get(active.environmentId)).toMatchObject({
      state: "attached",
      destroyRequestedAtMs: support.testState.nowMs,
    });
    expect(support.testState.store.getCredential(environmentId)?.expiresAtMs).toBe(
      expiredCredential.expiresAtMs,
    );
    expect(tunnelManager.start).toHaveBeenCalledWith(
      expect.objectContaining({ bundleHash: support.BUNDLE_HASH }),
    );
  });

  it("fails startup-deferred preparation after authoritative environment destruction", async () => {
    const placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    const harness = createHarness(placements);
    harness.placements.seedStarting();
    harness.markEnvironmentDestroyed();

    await harness.service.reconcileActive();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: "Interrupted worker dispatch cannot safely resume",
    });
    expect(harness.environments.attachSession).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });
});
