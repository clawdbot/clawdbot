import { describe, expect, it, vi } from "vitest";
import { bindCloudWorkerSetupCompletion } from "../../infra/device-pairing-cloud-worker.js";
import type {
  WorkerNodeEnrollment,
  WorkerNodeRuntimePreparation,
  WorkerProvider,
} from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
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
        nodeBootstrap: support.NODE_BOOTSTRAP,
        displayName: "Cloud worker test",
        waitForDeviceId: async () => "cloud-device-1",
      };
    });
    const closeNodeEnrollment = vi.fn();
    const retireNodeEnrollment = vi.fn(async () => {});
    let begin: (() => Promise<WorkerNodeEnrollment>) | undefined;
    const provision = vi.fn<WorkerProvider["provision"]>(
      async (_profile, _operationId, options) => {
        begin = options?.beginNodeEnrollment;
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
        closeNodeEnrollment,
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
    expect(closeNodeEnrollment).toHaveBeenCalledExactlyOnceWith(
      await prepareNodeEnrollment.mock.results[0]!.value,
    );
    await expect(begin!()).rejects.toThrow("Worker provisioning operation is closed");
    expect(prepareNodeEnrollment).toHaveBeenCalledOnce();

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

  it.each(["ready", "failure", "teardown"] as const)(
    "prepares the node runtime before allocation when preparation ends in %s",
    async (outcome) => {
      const entered = createDeferredCore();
      const prepared = createDeferredCore();
      const provision = vi.fn(async () => {
        entered.resolve();
        return {
          leaseId: "cloud-lease-prepared",
          node: { deviceId: "cloud-device-prepared" },
          sharedHost: false,
        };
      });
      const workerService = support.createService(
        support.createProvider({
          supportedExecutionModes: ["worker-turn"],
          provisionBeforeInstallation: true,
          requiresNodeEnrollment: true,
          provision,
        }),
        {
          prepareNodeBootstrap: async () => {
            entered.resolve();
            await prepared.promise;
          },
          prepareNodeEnrollment: async () => {
            throw new Error("provider does not need enrollment in this case");
          },
          ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT),
        },
      );
      const creation = workerService.create("development", `request-node-preparation-${outcome}`);
      const completed = creation.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await entered.promise;
        expect(provision).not.toHaveBeenCalled();
        const record = support.testState.store.list()[0]!;
        expect(record.state).toBe("requested");
        if (outcome === "teardown") {
          support.testState.store.requestDestroy({
            environmentId: record.environmentId,
            state: "requested",
          });
        }
        if (outcome === "failure") {
          prepared.reject(new Error("node package is incomplete"));
        } else {
          prepared.resolve();
        }
        expect(await completed).toMatchObject(
          outcome === "ready"
            ? { value: { state: "ready" } }
            : {
                error: {
                  message: expect.stringContaining(
                    outcome === "failure"
                      ? "node package is incomplete"
                      : "changed during bootstrap preparation",
                  ),
                },
              },
        );
        expect(provision).toHaveBeenCalledTimes(outcome === "ready" ? 1 : 0);
      } finally {
        prepared.resolve();
        await completed;
      }
    },
  );

  it.each(["provider-error", "provider-timeout", "enrollment-timeout", "runtime-timeout"] as const)(
    "closes the exact enrollment and rejects retained callbacks after %s",
    async (outcome) => {
      const providerEntered = createDeferredCore();
      const finishProvider = createDeferredCore();
      const finishEnrollment = createDeferredCore<WorkerNodeEnrollment>();
      const finishRuntime = createDeferredCore<WorkerNodeRuntimePreparation>();
      const runtime: WorkerNodeRuntimePreparation = { nodeBootstrap: support.NODE_BOOTSTRAP };
      let runtimeSignal: AbortSignal | undefined;
      const prepareNodeRuntime = vi.fn(async (_record, signal?: AbortSignal) => {
        runtimeSignal = signal;
        return outcome === "runtime-timeout" ? await finishRuntime.promise : runtime;
      });
      const closeNodeRuntime = vi.fn();
      const enrollment: WorkerNodeEnrollment = {
        mode: "resume",
        deviceId: "cloud-device-closed",
        openclawVersion: "2026.8.1",
        nodeBootstrap: support.NODE_BOOTSTRAP,
        displayName: "Cloud worker lifecycle",
        waitForDeviceId: async () => "cloud-device-closed",
      };
      const prepareNodeEnrollment = vi.fn(async () =>
        outcome === "enrollment-timeout" ? await finishEnrollment.promise : enrollment,
      );
      const closeNodeEnrollment = vi.fn();
      let begin: (() => Promise<WorkerNodeEnrollment>) | undefined;
      let pendingEnrollment: Promise<WorkerNodeEnrollment> | undefined;
      let prepareRuntime: (() => Promise<WorkerNodeRuntimePreparation>) | undefined;
      let pendingRuntime: Promise<WorkerNodeRuntimePreparation> | undefined;
      const workerService = support.createService(
        support.createProvider({
          supportedExecutionModes: ["worker-turn"],
          provisionBeforeInstallation: true,
          requiresNodeEnrollment: true,
          provision: async (_profile, _operationId, options) => {
            begin = options!.beginNodeEnrollment!;
            prepareRuntime = options!.prepareNodeRuntime!;
            pendingRuntime = prepareRuntime();
            if (outcome === "runtime-timeout") {
              providerEntered.resolve();
            }
            await pendingRuntime;
            pendingEnrollment = begin();
            providerEntered.resolve();
            await pendingEnrollment;
            if (outcome === "provider-error") {
              throw new Error("provider response lost");
            }
            await finishProvider.promise;
            return { leaseId: "cloud-lease-closed", node: { deviceId: "cloud-device-closed" } };
          },
        }),
        {
          prepareNodeRuntime,
          closeNodeRuntime,
          prepareNodeEnrollment,
          closeNodeEnrollment,
          providerCallTimeoutMs: 20,
        },
      );
      const creation = workerService.create("development", `request-node-closed-${outcome}`);
      const rejected = expect(creation).rejects.toMatchObject({ code: "provider_failure" });
      try {
        await providerEntered.promise;
        await rejected;
        expect(runtimeSignal?.aborted).toBe(true);
        if (outcome === "runtime-timeout") {
          const lateRejected = expect(pendingRuntime).rejects.toThrow(
            "Worker provisioning operation is closed",
          );
          finishRuntime.resolve(runtime);
          await lateRejected;
        }
        if (outcome === "enrollment-timeout") {
          const lateRejected = expect(pendingEnrollment).rejects.toThrow(
            "Worker provisioning operation is closed",
          );
          finishEnrollment.resolve(enrollment);
          await lateRejected;
        }
        await expect(begin!()).rejects.toMatchObject({
          name: "AbortError",
          message: "Worker provisioning operation is closed",
        });
        await expect(prepareRuntime!()).rejects.toMatchObject({
          name: "AbortError",
          message: "Worker provisioning operation is closed",
        });
        expect(closeNodeRuntime).toHaveBeenCalledExactlyOnceWith(runtime);
        expect(prepareNodeRuntime).toHaveBeenCalledOnce();
        if (outcome === "runtime-timeout") {
          expect(closeNodeEnrollment).not.toHaveBeenCalled();
          expect(prepareNodeEnrollment).not.toHaveBeenCalled();
        } else {
          expect(closeNodeEnrollment).toHaveBeenCalledExactlyOnceWith(enrollment);
          expect(prepareNodeEnrollment).toHaveBeenCalledOnce();
        }
      } finally {
        finishEnrollment.resolve(enrollment);
        finishRuntime.resolve(runtime);
        finishProvider.resolve();
      }
    },
  );

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
        nodeBootstrap: support.NODE_BOOTSTRAP,
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
