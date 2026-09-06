import { describe, expect, it, vi } from "vitest";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { WorkerDispatchTargetChangedError } from "../server-worker-placement-session-target.js";
import {
  MANIFEST_REF,
  REQUEST,
  seedProvisioningPlacement,
} from "./placement-dispatch-test-fixtures.js";
import { createHarness, createRecoveryService } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import {
  deriveEnvironmentIntent,
  WorkerPlacementAdmissionTargetError,
} from "./service-contract.js";
import * as support from "./service.test-support.js";

describe("worker placement shutdown replay", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("retains interrupted fresh provisioning and activates the same operation after restart", async () => {
    support.testState.prepareInstallation = async () => ({
      ...support.BUNDLE_ARTIFACT,
      protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
    });
    const interrupted = createDeferredCore<never>();
    const provisionStarted = createDeferredCore();
    const operationIds: string[] = [];
    const destroy = vi.fn(async () => {});
    const provider = support.createProvider({
      provision: async (_profile, operationId) => {
        operationIds.push(operationId);
        if (operationIds.length === 1) {
          provisionStarted.resolve();
          await interrupted.promise;
        }
        return { leaseId: "lease-shutdown-replay", ssh: support.SSH_ENDPOINT, sharedHost: false };
      },
      destroy,
    });
    let placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const first = support.createService(provider);
    let shuttingDown = false;
    const dispatch = createRecoveryService(placements, first, () => shuttingDown);
    const transitions: string[] = [];
    const request = { ...REQUEST, executionMode: "remote-exec" as const };
    const rejected = expect(
      dispatch.dispatch(request, (placement) => transitions.push(placement.state)),
    ).rejects.toThrow("provider interrupted");
    await provisionStarted.promise;
    const provisioning = placements.get(REQUEST.sessionId)!;
    const environmentId = provisioning.environmentId!;
    const operationId = support.testState.store.get(environmentId)!.provisionOperationId;
    shuttingDown = true;
    interrupted.reject(new Error("provider interrupted"));
    await rejected;

    expect(placements.get(REQUEST.sessionId)).toMatchObject({
      state: "provisioning",
      terminalAtMs: null,
      generation: provisioning.generation,
      environmentId,
    });
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "provisioning",
      destroyRequestedAtMs: null,
      provisionOperationId: operationId,
      lastError: expect.stringContaining("provider interrupted"),
    });
    expect(transitions).toEqual(["requested", "provisioning", "provisioning"]);
    expect(destroy).not.toHaveBeenCalled();

    await support.reopenWorkerEnvironmentStore();
    placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const restarted = support.createService(provider);
    const syncWorkspace = vi.fn(async () => ({
      mode: "git" as const,
      remoteWorkspaceDir: "/worker/workspace",
      manifestRef: MANIFEST_REF,
    }));
    vi.spyOn(restarted, "startTunnel").mockImplementation(async (owner) => ({
      ...owner,
      syncWorkspace,
      runWorkspaceCommand: vi.fn(),
      quiesceWorkspace: vi.fn(),
      reconcileWorkspace: vi.fn(),
      stop: vi.fn(),
    }));
    const attach = vi.spyOn(restarted, "attachSession");
    const recovery = createRecoveryService(placements, restarted);
    const owner = placements.get(REQUEST.sessionId)!;
    if (owner.state !== "provisioning") {
      throw new Error("restart lost its provisioning owner");
    }
    await recovery.resumeProvisioning(owner, () => restarted.reconcileEnvironment(environmentId));

    expect(placements.get(REQUEST.sessionId)).toMatchObject({ state: "active", environmentId });
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "attached",
      provisionOperationId: operationId,
      leaseId: "lease-shutdown-replay",
      attachedSessionIds: [REQUEST.sessionId],
    });
    expect(operationIds).toEqual([operationId, operationId]);
    expect(support.testState.store.list().map((record) => record.environmentId)).toEqual([
      environmentId,
    ]);
    expect(attach).toHaveBeenCalledOnce();
    expect(syncWorkspace).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "retains admitted recovery with shutdown=%s and only rethrows shutdown interruptions",
    async (shutdown) => {
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const environments = support.createService(support.createProvider());
      const intent = deriveEnvironmentIntent(`session-dispatch:${REQUEST.sessionId}:1`);
      support.testState.store.createIntent({
        ...intent,
        providerId: "fake",
        profileId: "development",
        profileSnapshot: { settings: { region: "test" } },
      });
      const owner = seedProvisioningPlacement(placements, intent.environmentId, "remote-exec");
      if (owner.state !== "provisioning") {
        throw new Error("recovery fixture requires provisioning");
      }
      const dispatch = createRecoveryService(placements, environments, () => shutdown);
      const interrupted = new Error(`recovery interrupted ${"x".repeat(2_000)}`);
      const report = vi.fn();
      const recordError = vi.spyOn(environments, "recordError");
      const recovery = dispatch.resumeProvisioning(
        owner,
        async () => {
          throw interrupted;
        },
        report,
      );
      if (shutdown) {
        await expect(recovery).rejects.toBe(interrupted);
        expect(recordError).toHaveBeenCalledOnce();
        expect(report).toHaveBeenCalledTimes(2);
        const lastError = support.testState.store.get(intent.environmentId)?.lastError;
        expect(lastError).toMatch(/^recovery interrupted /);
        expect(lastError?.length).toBeLessThanOrEqual(1_024);
      } else {
        await expect(recovery).resolves.toBeUndefined();
        expect(recordError).not.toHaveBeenCalled();
        expect(report).toHaveBeenCalledOnce();
      }
      expect(placements.get(REQUEST.sessionId)).toEqual(owner);
      expect(support.testState.store.get(intent.environmentId)).toMatchObject({
        state: "requested",
        provisionOperationId: intent.provisionOperationId,
        destroyRequestedAtMs: null,
      });
    },
  );

  it.each([
    new WorkerPlacementAdmissionTargetError("session admission revoked"),
    new WorkerDispatchTargetChangedError("session runtime changed"),
  ])("tears down an invalid recovery owner during shutdown: %s", async (error) => {
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const harness = createHarness(placements, {
      isShuttingDown: () => true,
      recoveryBarrierError: error,
    });
    const owner = harness.placements.seedProvisioning();
    if (owner.state !== "provisioning") {
      throw new Error("recovery fixture requires provisioning");
    }
    vi.mocked(harness.environments.get).mockReturnValue({
      ...harness.ready,
      state: "provisioning",
      leaseId: null,
      sshEndpoint: null,
      bootstrapReceipt: null,
      sharedHost: null,
    });

    await harness.service.resumeProvisioning(owner, async () => {});

    expect(placements.get(REQUEST.sessionId)).toMatchObject({ state: "failed" });
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
    expect(harness.environments.recordError).not.toHaveBeenCalled();
  });

  it.each([
    { shutdown: false, destroyRequested: false },
    { shutdown: true, destroyRequested: true },
  ])(
    "tears down rejected provisioning with $shutdown shutdown and $destroyRequested destroy intent",
    async ({ shutdown, destroyRequested }) => {
      const provider = support.createProvider({
        provision: async (_profile, operationId) => {
          const environment = support.testState.store
            .list()
            .find((record) => record.provisionOperationId === operationId)!;
          if (destroyRequested) {
            support.testState.store.requestDestroy({
              environmentId: environment.environmentId,
              state: environment.state,
            });
          }
          throw new Error("provider interrupted");
        },
      });
      const environments = support.createService(provider);
      const destroy = vi.spyOn(environments, "destroy");
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const dispatch = createRecoveryService(placements, environments, () => shutdown);

      await expect(dispatch.dispatch({ ...REQUEST, executionMode: "remote-exec" })).rejects.toThrow(
        "provider interrupted",
      );

      expect(placements.get(REQUEST.sessionId)).toMatchObject({ state: "failed" });
      expect(placements.get(REQUEST.sessionId)?.terminalAtMs).not.toBeNull();
      expect(destroy).toHaveBeenCalledOnce();
      expect(destroy).toHaveBeenCalledWith(
        deriveEnvironmentIntent(`session-dispatch:${REQUEST.sessionId}:1`).environmentId,
      );
    },
  );
});
