import { describe, expect, it, vi } from "vitest";
import { bindCloudWorkerSetupCompletion } from "../../infra/device-pairing-cloud-worker.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { admitWorkerConnection } from "./admission.js";
import { hashWorkerCredential } from "./credential.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import * as nodeTunnelSupport from "./node-worker-tunnel.test-support.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";

describe("node worker provider provisioning", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("supplies replay-safe enrollment only to providers that require it", async () => {
    const prepareNodeEnrollment = vi.fn(async (record) => {
      const enrolled = support.testState.store.ensureNodeEnrollment(record.environmentId);
      if (!enrolled.nodeSetupId) {
        throw new Error("expected persisted cloud enrollment ownership");
      }
      return {
        mode: "connect" as const,
        setupCode: "setup-code",
        setupId: enrolled.nodeSetupId,
        openclawVersion: "2026.8.1",
        packageSpecs: ["openclaw@2026.8.1"],
        displayName: "Cloud worker test",
        waitForDeviceId: async () => "cloud-device-1",
      };
    });
    const retireNodeEnrollment = vi.fn(async () => {});
    const provision = vi.fn<WorkerProvider["provision"]>(
      async (_profile, _operationId, options) => {
        await expect(options?.beginNodeEnrollment?.()).resolves.toMatchObject({
          mode: "connect",
          setupId: expect.any(String),
        });
        return {
          leaseId: "cloud-lease-1",
          node: { deviceId: "cloud-device-1" },
          sharedHost: false,
        };
      },
    );
    const workerService = support.createService(
      support.createProvider({
        supportedExecutionModes: ["worker-turn"],
        provisionBeforeInstallation: true,
        requiresNodeEnrollment: true,
        provision,
      }),
      {
        prepareNodeEnrollment,
        retireNodeEnrollment,
        ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT),
      },
    );

    const environment = await workerService.create("development", "request-cloud-node");
    expect(environment).toMatchObject({
      state: "ready",
      nodeSetupId: expect.any(String),
      nodeDeviceId: "cloud-device-1",
      sharedHost: false,
    });
    expect(prepareNodeEnrollment).toHaveBeenCalledOnce();
    expect(provision).toHaveBeenCalledOnce();

    await expect(workerService.destroy(environment.environmentId)).resolves.toMatchObject({
      state: "destroyed",
    });
    expect(retireNodeEnrollment).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeSetupId: environment.nodeSetupId,
        nodeDeviceId: "cloud-device-1",
        state: "destroying",
      }),
    );
  });

  it("destroys an unreported node allocation without reenrolling or admitting its worker", async () => {
    const leaseId = "cloud-lease-destroy-replay";
    const deviceId = "cloud-device-destroy-replay";
    const operationIds: string[] = [];
    const ensureNodeWorkerBundle = vi.fn(async () => structuredClone(support.BOOTSTRAP_RECEIPT));
    const generateWorkerCredential = vi.fn(() => support.CREDENTIAL);
    const retireNodeEnrollment = vi.fn(async () => {});
    const destroy = vi.fn(async () => {});
    const transport = nodeTunnelSupport.transport();
    const listNodes = vi.fn(async () => []);
    transport.listCurrentNodes = listNodes;
    const invoke = vi.spyOn(transport, "invoke");
    const workspaceTransfer = nodeTunnelSupport.workspaceTransfer();
    workspaceTransfer.closeAll = vi.fn(async () => {});
    const nodeTunnels = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-1",
      getEnvironment: (id) => support.testState.store.get(id),
      listEnvironments: () => support.testState.store.list(),
      getTransport: () => transport,
      launchNodeWorker: vi.fn(),
      validateWorkerTurn: () => false,
      workspaceTransfer,
    });
    const stop = vi.spyOn(nodeTunnels, "stop");
    const transitions = vi.spyOn(support.testState.store, "transition");
    const prepareNodeEnrollment = vi.fn(async (record) => {
      const enrolled = support.testState.store.ensureNodeEnrollment(record.environmentId);
      if (!enrolled.nodeSetupId) {
        throw new Error("expected persisted cloud enrollment ownership");
      }
      return {
        mode: "connect" as const,
        setupCode: "setup-code",
        setupId: enrolled.nodeSetupId,
        openclawVersion: "2026.8.1",
        packageSpecs: ["openclaw@2026.8.1"],
        displayName: "Cloud worker destroy replay",
        waitForDeviceId: async () => deviceId,
      };
    });
    const workerService = support.createService(
      support.createProvider({
        supportedExecutionModes: ["worker-turn"],
        provisionBeforeInstallation: true,
        requiresNodeEnrollment: true,
        resolveAllocation: async () => ({ leaseId, sharedHost: false }),
        provision: async (_profile, operationId, options) => {
          operationIds.push(operationId);
          const enrollment = await options?.beginNodeEnrollment?.();
          if (enrollment?.mode !== "connect") {
            throw new Error("expected pending enrollment");
          }
          bindCloudWorkerSetupCompletion({
            db: support.testState.stateDb.db,
            completion: { setupId: enrollment.setupId, deviceId, completedAtMs: 1_000 },
          });
          throw new Error("provider response was lost after node allocation");
        },
        destroy,
      }),
      {
        prepareNodeEnrollment,
        retireNodeEnrollment,
        ensureNodeWorkerBundle,
        generateWorkerCredential,
        nodeTunnelManager: nodeTunnels,
      },
    );

    await expect(
      workerService.create("development", "request-node-destroy-replay"),
    ).rejects.toMatchObject({ code: "provider_failure" });
    const provisioning = support.testState.store.list()[0]!;
    expect(provisioning).toMatchObject({
      state: "provisioning",
      leaseId: null,
      nodeSetupId: expect.any(String),
      nodeDeviceId: deviceId,
    });

    support.testState.providersEnabled = false;
    await expect(workerService.destroy(provisioning.environmentId)).rejects.toMatchObject({
      code: "provider_not_found",
    });
    expect(stop).toHaveBeenCalledExactlyOnceWith(provisioning.environmentId, 0, undefined);
    expect(support.testState.store.get(provisioning.environmentId)).toMatchObject({
      state: "provisioning",
      leaseId: null,
      nodeDeviceId: deviceId,
      destroyRequestedAtMs: expect.any(Number),
    });
    expect(destroy).not.toHaveBeenCalled();

    support.testState.providersEnabled = true;
    await expect(workerService.destroy(provisioning.environmentId)).resolves.toMatchObject({
      state: "destroyed",
      leaseId,
      nodeDeviceId: deviceId,
      sharedHost: false,
      desktop: null,
    });

    expect(operationIds).toEqual([provisioning.provisionOperationId]);
    expect(listNodes).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(prepareNodeEnrollment).toHaveBeenCalledOnce();
    expect(ensureNodeWorkerBundle).not.toHaveBeenCalled();
    expect(support.testState.prepareInstallation).not.toHaveBeenCalled();
    expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
    expect(generateWorkerCredential).not.toHaveBeenCalled();
    expect(support.testState.store.getCredential(provisioning.environmentId)).toBeUndefined();
    expect(transitions).not.toHaveBeenCalledWith(expect.objectContaining({ to: "ready" }));
    expect(destroy).toHaveBeenCalledExactlyOnceWith({ leaseId, profile: { region: "test" } });
    expect(retireNodeEnrollment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        state: "destroying",
        leaseId,
        nodeSetupId: provisioning.nodeSetupId,
        nodeDeviceId: deviceId,
        sharedHost: false,
        desktop: null,
        bootstrapReceipt: null,
        ownerEpoch: 0,
      }),
    );
    expect(support.testState.store.get(provisioning.environmentId)).toMatchObject({
      state: "destroyed",
      bootstrapReceipt: null,
      ownerEpoch: 0,
    });
    expect(
      workerService.takeMintedCredential({
        environmentId: provisioning.environmentId,
        ownerEpoch: 0,
        sessionId: null,
      }),
    ).toBeUndefined();
  });

  it("keeps paired-device roles when a node lease has no cloud enrollment owner", async () => {
    const retireNodeEnrollment = vi.fn(async () => {});
    const workerService = support.createService(
      support.createProvider({
        supportedExecutionModes: ["worker-turn"],
        provisionBeforeInstallation: true,
        provision: async () => ({
          leaseId: "device-lease-1",
          node: { deviceId: "paired-device-1" },
          sharedHost: true,
        }),
      }),
      {
        retireNodeEnrollment,
        ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT),
      },
    );

    const environment = await workerService.create("development", "request-paired-device");
    expect(environment).toMatchObject({
      state: "ready",
      nodeSetupId: null,
      nodeDeviceId: "paired-device-1",
    });

    await expect(workerService.destroy(environment.environmentId)).resolves.toMatchObject({
      state: "destroyed",
    });
    expect(retireNodeEnrollment).not.toHaveBeenCalled();
  });

  it("commits an installed Gateway bundle receipt and credential for a node lease", async () => {
    const workerBuild = structuredClone(support.BOOTSTRAP_RECEIPT);
    const placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    const placementGate = createWorkerSessionPlacementGate(placements);
    const workerService = support.createService(
      support.createProvider({
        supportedExecutionModes: ["worker-turn"],
        provisionBeforeInstallation: true,
        provision: async () => ({
          leaseId: "device-lease-1",
          node: { deviceId: "device-1" },
          sharedHost: true,
        }),
      }),
      { ensureNodeWorkerBundle: async () => workerBuild, placementStore: placementGate },
    );

    const result = await workerService.create("development", "request-device");

    expect(result).toMatchObject({
      state: "ready",
      leaseId: "device-lease-1",
      nodeDeviceId: "device-1",
      sshEndpoint: null,
      bootstrapReceipt: { ...workerBuild, installKind: "bundle" },
      sharedHost: true,
      ownerEpoch: 1,
    });
    expect(support.testState.prepareInstallation).not.toHaveBeenCalled();
    expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
    const credential = workerService.takeMintedCredential({
      environmentId: result.environmentId,
      ownerEpoch: result.ownerEpoch,
      sessionId: null,
    });
    expect(credential).toMatchObject({
      credential: support.CREDENTIAL,
      bundleHash: support.BUNDLE_HASH,
    });
    const attachedCredential = await workerService.attachSession({
      environmentId: result.environmentId,
      ownerEpoch: result.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    await support.waitForFast(() => {
      expect({
        environment: support.testState.store.get(result.environmentId),
        credential: support.testState.store.getCredential(result.environmentId),
      }).toMatchObject({
        environment: {
          state: "attached",
          ownerEpoch: attachedCredential.ownerEpoch,
          attachedSessionIds: [REQUEST.sessionId],
        },
        credential: {
          credentialHash: hashWorkerCredential(attachedCredential.credential),
          bundleHash: workerBuild.bundleHash,
          sessionId: REQUEST.sessionId,
          ownerEpoch: attachedCredential.ownerEpoch,
        },
      });
    });
    seedActivePlacement(placements, {
      environmentId: result.environmentId,
      ownerEpoch: attachedCredential.ownerEpoch,
    });
    const turnClaim = placements.claimTurn({
      sessionId: REQUEST.sessionId,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
      claimId: "claim-device",
      runId: "run-device",
      owner: {
        kind: "worker",
        environmentId: result.environmentId,
        ownerEpoch: attachedCredential.ownerEpoch,
      },
    });
    const turnCredential = await workerService.acquireTurnCredential(turnClaim);
    const admission = {
      environmentId: result.environmentId,
      credential: turnCredential.credential,
      ownerEpoch: attachedCredential.ownerEpoch,
      rpcSetVersion: 1,
      sessionId: REQUEST.sessionId,
      runId: turnClaim.runId,
      handshake: workerBuild,
    } as const;
    expect(
      admitWorkerConnection({
        store: support.testState.store,
        admission,
        expectedBuild: workerBuild,
        nowMs: support.testState.nowMs,
        turnClaim,
      }),
    ).toMatchObject({ ok: true });
    expect(
      admitWorkerConnection({
        store: support.testState.store,
        admission: {
          ...admission,
          handshake: { ...workerBuild, bundleHash: "d".repeat(64) },
        },
        expectedBuild: workerBuild,
        nowMs: support.testState.nowMs,
        turnClaim,
      }),
    ).toEqual({ ok: false, reason: "bundle-mismatch" });
  });
});
