import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";

const runtimeFactoryMocks = vi.hoisted(() => ({
  createDiskSpace: vi.fn(),
  createSessionEvidenceResolver: vi.fn(),
}));

vi.mock("./server-worker-placement-session-evidence.js", () => ({
  createWorkerPlacementSessionEvidenceResolver: runtimeFactoryMocks.createSessionEvidenceResolver,
}));

vi.mock("./worker-environments/placement-disk-space.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./worker-environments/placement-disk-space.js")>();
  return {
    ...actual,
    createWorkerPlacementDiskSpaceMonitor: runtimeFactoryMocks.createDiskSpace,
  };
});

import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import * as workerEnvironmentSupport from "./worker-environments/service.test-support.js";

describe("worker placement startup cleanup ownership", () => {
  workerEnvironmentSupport.setupWorkerEnvironmentServiceSuite();

  it("becomes ready before failed-placement lease adoption and drains its exact teardown", async () => {
    const environmentId = "worker-startup-indeterminate";
    const operationId = "provision:startup-indeterminate";
    const releaseProvision = createDeferredCore();
    const provisionStarted = createDeferredCore();
    const provision = vi.fn(async () => {
      provisionStarted.resolve();
      await releaseProvision.promise;
      return { leaseId: "lease-startup-adopted", ssh: workerEnvironmentSupport.SSH_ENDPOINT };
    });
    const destroy = vi.fn(async () => {});
    const environments = workerEnvironmentSupport.createService(
      workerEnvironmentSupport.createProvider({ provision, destroy }),
    );
    const intent = workerEnvironmentSupport.testState.store.createIntent({
      environmentId,
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test" } },
      provisionOperationId: operationId,
    });
    workerEnvironmentSupport.testState.store.transition({
      environmentId,
      from: intent.state,
      to: "provisioning",
    });
    workerEnvironmentSupport.testState.store.requestDestroy({
      environmentId,
      state: "provisioning",
    });
    const placements = createWorkerSessionPlacementStore({
      database: workerEnvironmentSupport.testState.stateDb,
      now: () => workerEnvironmentSupport.testState.nowMs,
    });
    const requested = placements.startDispatch({
      sessionId: "session-startup-indeterminate",
      sessionKey: "agent:main:startup-indeterminate",
      agentId: "main",
      executionMode: "remote-exec",
    });
    const provisioning = placements.transition({
      sessionId: requested.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: requested.generation,
      patch: { environmentId },
    });
    const failed = placements.fail({
      sessionId: provisioning.sessionId,
      expectedGeneration: provisioning.generation,
      recoveryError: "startup worker placement failed",
    });
    expect(failed).toMatchObject({
      state: "failed",
      environmentId,
      turnClaim: null,
      activeOwnerEpoch: null,
    });
    runtimeFactoryMocks.createSessionEvidenceResolver.mockResolvedValue(async () => "current");
    runtimeFactoryMocks.createDiskSpace.mockReturnValue({
      read: vi.fn(),
      version: vi.fn(() => 0),
      sweep: vi.fn().mockResolvedValue(undefined),
    });
    const runtime = createGatewayWorkerPlacementRuntime({
      placements,
      environments,
      gatewayNamespace: "gateway-test",
      revokeSessionAuthority: vi.fn(),
      warn: vi.fn(),
    });
    let registeredSidecar: { stop: () => Promise<void> } | undefined;
    const starting = runtime.startRuntime({
      isClosePreludeStarted: () => false,
      registerSidecar: (sidecar) => {
        registeredSidecar = sidecar;
      },
      unregisterSidecar: vi.fn(),
    });

    try {
      const first = await Promise.race([
        starting.then((sidecar) => ({ kind: "ready" as const, sidecar })),
        provisionStarted.promise.then(() => ({ kind: "provision" as const })),
      ]);
      expect(first.kind).toBe("ready");
      if (first.kind !== "ready" || !first.sidecar) {
        throw new Error("worker startup did not reach readiness before provider adoption");
      }
      await provisionStarted.promise;
      expect(provision).toHaveBeenCalledWith({ region: "test" }, operationId, undefined);
      expect(workerEnvironmentSupport.testState.store.get(environmentId)).toMatchObject({
        state: "provisioning",
        leaseId: null,
        destroyRequestedAtMs: expect.any(Number),
      });

      let stopped = false;
      const stopping = first.sidecar.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(destroy).not.toHaveBeenCalled();

      releaseProvision.resolve();
      await stopping;

      expect(destroy).toHaveBeenCalledWith({
        leaseId: "lease-startup-adopted",
        profile: { region: "test" },
      });
      expect(workerEnvironmentSupport.testState.store.get(environmentId)).toMatchObject({
        state: "destroyed",
        leaseId: "lease-startup-adopted",
      });
    } finally {
      releaseProvision.resolve();
      await starting.catch(() => undefined);
      await registeredSidecar?.stop();
    }
  });
});
