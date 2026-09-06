import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import type { WorkerNodeEnrollment } from "../../plugins/types.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import { createWorkerNodeEnrollmentManager } from "./node-enrollment.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createWorkerPlacementDispatchService } from "./placement-dispatch.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import * as support from "./service.test-support.js";
import { createWorkerEnvironmentStore } from "./store.js";
import { createWorkerBootstrapArtifactTransferService } from "./worker-bootstrap-artifact-transfer-service.js";
import { measureLaunchTurn } from "./worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

describe("worker node provisioning shutdown replay", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("cancels guarded enrollment without releasing the exact lease and adopts it after restart", async () => {
    const deviceId = "device-node-shutdown-replay";
    const leaseId = "lease-node-shutdown-replay";
    const operationIds: string[] = [];
    const physicalLeases = new Set<string>();
    const enrollments: WorkerNodeEnrollment[] = [];
    support.testState.config.gateway = { publicOrigin: "https://gateway.example.test" };
    const prepareArtifact = async () => ({
      tarballPath: "/gateway/cache/node-runtime.tgz",
      tarballSha256: support.NODE_BOOTSTRAP.sha256,
      tarballBytes: support.NODE_BOOTSTRAP.bytes,
      openclawVersion: support.NODE_BOOTSTRAP.openclawVersion,
      enabledPluginIds: support.NODE_BOOTSTRAP.enabledPluginIds,
      buildId: "gateway-source-build",
    });
    const destroy = vi.fn(async ({ leaseId: destroyedLeaseId }: { leaseId: string }) => {
      physicalLeases.delete(destroyedLeaseId);
    });
    let physicalAllocations = 0;
    const provider = support.createProvider({
      supportedExecutionModes: ["worker-turn"],
      provisionBeforeInstallation: true,
      requiresNodeEnrollment: true,
      provision: async (_profile, operationId, options) => {
        operationIds.push(operationId);
        if (!physicalLeases.has(leaseId)) {
          physicalLeases.add(leaseId);
          physicalAllocations += 1;
        }
        const enrollment = await options?.beginNodeEnrollment?.();
        if (!enrollment) {
          throw new Error("node enrollment was not prepared");
        }
        enrollments.push(enrollment);
        return {
          leaseId,
          node: { deviceId: await enrollment.waitForDeviceId() },
          sharedHost: false,
        };
      },
      destroy,
    });
    support.testState.prepareInstallation = vi.fn(async () => ({
      ...support.BUNDLE_ARTIFACT,
      protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
    }));
    let placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    const requested = placements.startDispatch(REQUEST);
    const intent = deriveEnvironmentIntent(
      `session-dispatch:${REQUEST.sessionId}:${requested.generation}`,
    );
    const placement = placements.transition({
      sessionId: requested.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: requested.generation,
      patch: { environmentId: intent.environmentId },
    });
    const environment = support.testState.store.createIntent({
      environmentId: intent.environmentId,
      providerId: provider.id,
      profileId: "development",
      profileSnapshot: { install: "bundle", settings: { region: "test" } },
      provisionOperationId: intent.provisionOperationId,
    });
    support.testState.store.transition({
      environmentId: environment.environmentId,
      from: "requested",
      to: "provisioning",
      patch: { nodeDeviceId: deviceId },
    });
    const unavailable = vi.fn(async () => ({ available: false as const }));
    const firstTransfer = createWorkerBootstrapArtifactTransferService();
    const firstEnrollment = createWorkerNodeEnrollmentManager({
      store: support.testState.store,
      getConfig: () => support.testState.config,
      resolveAvailability: unavailable,
      prepareArtifact,
      transfer: firstTransfer,
    });
    const receipt = {
      ...support.BOOTSTRAP_RECEIPT,
      protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
    };
    const first = support.createService(provider, {
      prepareNodeBootstrap: firstEnrollment.prepare,
      prepareNodeEnrollment: firstEnrollment.begin,
      closeNodeEnrollment: firstEnrollment.close,
      stopNodeEnrollmentWaits: firstEnrollment.stop,
      ensureNodeWorkerBundle: async () => receipt,
    });

    const createDispatch = (environments: typeof first) =>
      createWorkerPlacementDispatchService({
        placements,
        environments,
        runnerAvailability: { read: () => undefined, version: () => 0 },
        resolveDevicePlacementRequirement: async () => ({
          requiredNodeCommands: [],
          consumesWorkerSlot: true,
        }),
        isCurrentNodePlacement: () => true,
        workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
        runLocalBarrier: async ({ startDispatch }) => startDispatch(),
        runRecoveryBarrier: async ({ run }) =>
          await run({ kind: "local", path: "/gateway/workspace" }),
        runActivationBarrier: async ({ activate }) => activate(),
        runMoveBarrier: async ({ begin }) => begin(),
        resolveMoveDestination: async () => undefined,
        runReclaimPreparation: async ({ run, authorize }) => await run(authorize),
        runReclaimBarrier: async ({ begin, reclaim }) =>
          await reclaim({ kind: "local", path: "/gateway/workspace" }, begin()),
        runFailedReclaimBarrier: async ({ reclaim }) => await reclaim(),
        resolveWorkspace: async () => ({ kind: "local", path: "/gateway/workspace" }),
        reportWorkspaceResultConflict: async () => {},
        resolveWorkspaceResultConflict: async () => ({ kind: "absent" }),
      });
    const firstDispatch = createDispatch(first);
    const uninstallFirstGuard = first.installReconcileEnvironmentGuard(
      async (environmentId, reconcileCore) => {
        const owner = placements
          .list()
          .find((candidate) => candidate.environmentId === environmentId);
        if (owner?.state !== "provisioning") {
          throw new Error("guarded recovery lost its provisioning owner");
        }
        await firstDispatch.resumeProvisioning(owner, reconcileCore);
      },
    );
    const recovery = firstDispatch.reconcile();
    await support.waitForFast(() => expect(unavailable).toHaveBeenCalled());

    let stopped = false;
    const stopping = first.stop().then(() => {
      stopped = true;
    });
    await support.waitForFast(() => expect(stopped).toBe(true), { timeout: 1_000 });
    await Promise.all([recovery, stopping]);
    await uninstallFirstGuard();
    expect(enrollments[0]?.signal?.aborted).toBe(true);
    expect(
      firstTransfer.authorize({
        token: enrollments[0]!.nodeBootstrap.token,
        artifactKey: enrollments[0]!.nodeBootstrap.sha256,
      }),
    ).toBeUndefined();

    expect(placements.get(REQUEST.sessionId)).toEqual(placement);
    expect(support.testState.store.get(intent.environmentId)).toMatchObject({
      state: "provisioning",
      leaseId: null,
      nodeDeviceId: deviceId,
      destroyRequestedAtMs: null,
      provisionOperationId: intent.provisionOperationId,
    });
    expect(physicalLeases).toEqual(new Set([leaseId]));
    expect(destroy).not.toHaveBeenCalled();

    support.testState.service = undefined;
    closeOpenClawStateDatabaseForTest();
    support.testState.stateDb = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: support.testState.root },
    });
    support.testState.store = createWorkerEnvironmentStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    const restartedTransfer = createWorkerBootstrapArtifactTransferService();
    const restartedEnrollment = createWorkerNodeEnrollmentManager({
      store: support.testState.store,
      getConfig: () => support.testState.config,
      resolveAvailability: async () => ({ available: true }),
      prepareArtifact,
      transfer: restartedTransfer,
    });
    const syncWorkspace = vi.fn(async () => ({
      mode: "git" as const,
      remoteWorkspaceDir: "/worker/workspace",
      manifestRef: `sha256:${"b".repeat(64)}`,
    }));
    const nodeTunnelManager = {
      status: () => "stopped" as const,
      start: vi.fn(async ({ environmentId, ownerEpoch }) => ({
        environmentId,
        ownerEpoch,
        measureLaunchTurn,
        launchTurn: vi.fn(),
        runWorkspaceCommand: vi.fn(),
        quiesceWorkspace: vi.fn(),
        syncWorkspace,
        reconcileWorkspace: vi.fn(),
        stop: vi.fn(),
      })),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    };
    const restarted = support.createService(provider, {
      prepareNodeBootstrap: restartedEnrollment.prepare,
      prepareNodeEnrollment: restartedEnrollment.begin,
      closeNodeEnrollment: restartedEnrollment.close,
      stopNodeEnrollmentWaits: restartedEnrollment.stop,
      ensureNodeWorkerBundle: async () => receipt,
      nodeTunnelManager: nodeTunnelManager as never,
    });
    bindDeviceWorkerAvailability(restarted, async (nodeId) => ({
      available: true,
      node: {
        nodeId,
        connId: `conn-${nodeId}`,
        pairingIdentity: `identity-${nodeId}`,
        pairingGeneration: `generation-${nodeId}`,
        clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
        protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
        workerHost: { enabled: true, capacity: { total: 1, available: 1 } },
        commands: [],
      },
    }));
    const restartedDispatch = createDispatch(restarted);
    const uninstallRestartedGuard = restarted.installReconcileEnvironmentGuard(
      async (environmentId, reconcileCore) => {
        const owner = expectDefined(
          placements.list().find((candidate) => candidate.environmentId === environmentId),
          "restarted provisioning owner",
        );
        if (owner.state !== "provisioning") {
          throw new Error("restarted recovery lost its provisioning placement");
        }
        await restartedDispatch.resumeProvisioning(owner, reconcileCore);
      },
    );

    await restartedDispatch.reconcile();
    await uninstallRestartedGuard();

    expect(placements.get(REQUEST.sessionId)).toMatchObject({
      state: "active",
      environmentId: intent.environmentId,
    });
    expect(support.testState.store.get(intent.environmentId)).toMatchObject({
      state: "attached",
      leaseId,
      nodeDeviceId: deviceId,
      attachedSessionIds: [REQUEST.sessionId],
      provisionOperationId: intent.provisionOperationId,
    });
    expect(operationIds).toEqual([intent.provisionOperationId, intent.provisionOperationId]);
    expect(physicalAllocations).toBe(1);
    expect(physicalLeases).toEqual(new Set([leaseId]));
    expect(syncWorkspace).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
  });
});
