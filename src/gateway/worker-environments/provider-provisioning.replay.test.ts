// Replay, restart-adoption, and serialization coverage for worker provider provisioning.
// Split from provider-provisioning.test.ts to stay under the max-lines cap.
import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import { WorkerProviderError } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createWorkerPlacementDispatchService } from "./placement-dispatch.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import * as support from "./service.test-support.js";
import { createWorkerEnvironmentStore } from "./store.js";
import { measureLaunchTurn } from "./worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

type WorkerEnvironmentServiceError = support.WorkerEnvironmentServiceError;

describe("worker environment service provision replay", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("adopts one committed provision across a service and store restart", async () => {
    const physicalLeases = new Set<string>();
    const operationIds: string[] = [];
    const machineClasses: Array<string | undefined> = [];
    const destroyed: string[] = [];
    let creates = 0;
    let loseFirstReply = true;
    const provider = () =>
      support.createProvider({
        provision: async (_profile, operationId, options) => {
          operationIds.push(operationId);
          machineClasses.push(options?.machineClass);
          if (!physicalLeases.has("lease-restarted")) {
            creates += 1;
            physicalLeases.add("lease-restarted");
          }
          if (loseFirstReply) {
            loseFirstReply = false;
            throw new Error("provider response was lost after commit");
          }
          return { leaseId: "lease-restarted", ssh: support.SSH_ENDPOINT };
        },
        destroy: async ({ leaseId }) => {
          destroyed.push(leaseId);
          physicalLeases.delete(leaseId);
        },
      });
    const first = support.createService(provider());

    await expect(
      first.create("development", "request-restart-replay", "large"),
    ).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    const environmentId = expectDefined(
      support.testState.store.list()[0],
      "persisted provision intent",
    ).environmentId;
    const operationId = expectDefined(
      support.testState.store.get(environmentId),
      "persisted provision record",
    ).provisionOperationId;
    expect(operationId).toMatch(/^provision:v2:[a-f0-9]{64}$/u);
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "provisioning",
      leaseId: null,
    });

    await first.stop();
    support.testState.service = undefined;
    closeOpenClawStateDatabaseForTest();
    support.testState.stateDb = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: support.testState.root },
    });
    support.testState.store = createWorkerEnvironmentStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });

    const restarted = support.createService(provider());
    restarted.start();
    await support.waitForFast(() =>
      expect(support.testState.store.get(environmentId)).toMatchObject({
        state: "ready",
        leaseId: "lease-restarted",
        lastError: null,
      }),
    );
    await restarted.destroy(environmentId);

    expect(creates).toBe(1);
    expect(operationIds).toEqual([operationId, operationId]);
    expect(machineClasses).toEqual(["large", "large"]);
    expect(destroyed).toEqual(["lease-restarted"]);
    expect(physicalLeases.size).toBe(0);
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "destroyed",
      leaseId: "lease-restarted",
    });
  });

  it("replays one node lease once across overlapping reconciliation and activates once", async () => {
    const events: string[] = [];
    const operationIds: string[] = [];
    const physicalLeases = new Set<string>();
    const enrollmentConnected = createDeferredCore<string>();
    const destroy = vi.fn(async ({ leaseId }: { leaseId: string }) => {
      physicalLeases.delete(leaseId);
    });
    let provisionCalls = 0;
    let physicalAllocations = 0;
    const provider = support.createProvider({
      supportedExecutionModes: ["worker-turn"],
      provisionBeforeInstallation: true,
      requiresNodeEnrollment: true,
      provision: async (_profile, operationId, options) => {
        provisionCalls += 1;
        events.push(`provision:${provisionCalls}`);
        operationIds.push(operationId);
        if (!physicalLeases.has("lease-node-replay")) {
          physicalLeases.add("lease-node-replay");
          physicalAllocations += 1;
        }
        if (provisionCalls === 1) {
          throw new Error("provider response was lost after exact lease allocation");
        }
        let enrollment;
        try {
          enrollment = await options?.beginNodeEnrollment?.();
        } catch (error) {
          events.push(`enrollment:error:${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
        if (!enrollment) {
          throw new Error("node enrollment was not prepared");
        }
        events.push("enrollment:start");
        return {
          leaseId: "lease-node-replay",
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
    const placement = placements.startDispatch(REQUEST);
    const idempotencyKey = `session-dispatch:${REQUEST.sessionId}:${placement.generation}`;
    const intent = deriveEnvironmentIntent(idempotencyKey);
    placements.transition({
      sessionId: placement.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: placement.generation,
      patch: { environmentId: intent.environmentId },
    });
    const first = support.createService(provider, {
      ensureNodeWorkerBundle: async () => ({
        ...support.BOOTSTRAP_RECEIPT,
        protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
      }),
      prepareNodeEnrollment: async () => {
        throw new Error("first provision reply was lost before node enrollment");
      },
    });

    await expect(
      first.create("development", idempotencyKey, undefined, REQUEST.executionMode),
    ).rejects.toMatchObject({ code: "provider_failure" });
    events.push("first:failed");
    expect(support.testState.store.get(intent.environmentId)).toMatchObject({
      state: "provisioning",
      leaseId: null,
      provisionOperationId: intent.provisionOperationId,
    });

    await first.stop();
    events.push("first:stopped");
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
      ensureNodeWorkerBundle: async () => ({
        ...support.BOOTSTRAP_RECEIPT,
        protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
      }),
      prepareNodeEnrollment: async (record) => {
        const enrolled = support.testState.store.ensureNodeEnrollment(record.environmentId);
        return {
          mode: "connect" as const,
          setupCode: "setup-code",
          setupId: enrolled.nodeSetupId!,
          openclawVersion: "2026.8.19",
          packageSpecs: ["openclaw@2026.8.19"],
          displayName: "Cloud worker replay",
          waitForDeviceId: async () => await enrollmentConnected.promise,
        };
      },
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
    const recoveryBarrier = vi.fn(async ({ expectedGeneration, environmentId, run }) => {
      expect(placements.get(REQUEST.sessionId)).toMatchObject({
        state: "provisioning",
        generation: expectedGeneration,
        environmentId,
      });
      await run("/gateway/workspace");
    });
    const activationBarrier = vi.fn(async ({ activate }) => activate());
    const onActivated = vi.fn();
    const attachSession = vi.spyOn(restarted, "attachSession");
    const dispatch = createWorkerPlacementDispatchService({
      placements,
      environments: restarted,
      runnerAvailability: { read: () => undefined, version: () => 0 },
      resolveDevicePlacementRequirement: async () => ({
        requiredNodeCommands: [],
        consumesWorkerSlot: true,
      }),
      isCurrentNodePlacement: () => true,
      workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
      runLocalBarrier: async ({ startDispatch }) => startDispatch(),
      runRecoveryBarrier: recoveryBarrier,
      runActivationBarrier: activationBarrier,
      runMoveBarrier: async ({ begin }) => begin(),
      resolveMoveDestination: async () => undefined,
      runReclaimBarrier: async ({ begin, reclaim }) => await reclaim("/gateway/workspace", begin()),
      runFailedReclaimBarrier: async ({ reclaim }) => await reclaim(),
      resolveWorkspacePath: async () => "/gateway/workspace",
      reportWorkspaceResultConflict: async () => {},
      resolveWorkspaceResultConflict: async () => undefined,
      onActivated,
    });
    const uninstallReconcileGuard = restarted.installReconcileEnvironmentGuard(
      async (environmentId, reconcileEnvironmentCore) => {
        const owners = placements
          .list()
          .filter((candidate) => candidate.environmentId === environmentId);
        if (owners.length !== 1 || owners[0]?.state !== "provisioning") {
          await reconcileEnvironmentCore();
          return;
        }
        await dispatch.resumeProvisioning(owners[0], reconcileEnvironmentCore);
      },
    );

    let recoverySettled = false;
    const recovery = dispatch.reconcile().finally(() => {
      recoverySettled = true;
    });
    events.push("recovery:started");
    await support.waitForFast(
      () => {
        if (!events.includes("enrollment:start")) {
          throw new Error(`node enrollment did not start: ${events.join(",")}`);
        }
      },
      { timeout: 2_000 },
    );
    expect(recoverySettled).toBe(false);
    expect(placements.get(REQUEST.sessionId)).toMatchObject({
      state: "provisioning",
      environmentId: intent.environmentId,
    });
    expect(support.testState.store.get(intent.environmentId)).toMatchObject({
      state: "provisioning",
      leaseId: null,
    });
    expect(nodeTunnelManager.start).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    const overlappingEnvironmentReconcile = restarted.reconcileEnvironment(intent.environmentId);
    const overlappingPlacementReconcile = dispatch.reconcileActive(intent.environmentId);
    await Promise.resolve();
    expect(provisionCalls).toBe(2);

    enrollmentConnected.resolve("device-node-replay");
    await Promise.all([recovery, overlappingEnvironmentReconcile, overlappingPlacementReconcile]);
    await uninstallReconcileGuard();

    expect(placements.get(REQUEST.sessionId)).toMatchObject({
      state: "active",
      environmentId: intent.environmentId,
      workerBundleHash: support.BUNDLE_HASH,
    });
    expect(support.testState.store.get(intent.environmentId)).toMatchObject({
      state: "attached",
      leaseId: "lease-node-replay",
      nodeDeviceId: "device-node-replay",
      attachedSessionIds: [REQUEST.sessionId],
    });
    expect(physicalAllocations).toBe(1);
    expect(operationIds).toEqual([intent.provisionOperationId, intent.provisionOperationId]);
    expect(recoveryBarrier).toHaveBeenCalled();
    expect(activationBarrier).not.toHaveBeenCalled();
    expect(attachSession).toHaveBeenCalledOnce();
    expect(nodeTunnelManager.start).toHaveBeenCalledOnce();
    expect(syncWorkspace).toHaveBeenCalledOnce();
    expect(onActivated).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
  });

  it.each([true, false])("recovers indeterminate cleanup (released: %s)", async (released) => {
    const leaseId = "lease:worker-provision-cleanup";
    const provision = vi.fn(async () => {
      throw WorkerProviderError.cleanupIndeterminate(
        leaseId,
        new Error("worker enrollment failed"),
        new Error("provider stop timed out after release was requested"),
      );
    });
    const inspect = vi.fn(async () => ({
      status: released ? ("destroyed" as const) : ("active" as const),
    }));
    const destroy = vi.fn(async () => {});
    const provider = support.createProvider({ provision, inspect, destroy });
    const workerService = support.createService(provider);

    await expect(
      workerService.create("development", "request-provision-cleanup"),
    ).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    const pending = expectDefined(support.testState.store.list()[0], "persisted provision cleanup");
    expect(pending).toMatchObject({
      state: "destroying",
      leaseId,
      destroyRequestedAtMs: expect.any(Number),
      teardownTerminalState: "failed",
      lastError: expect.stringMatching(
        /worker enrollment failed.*provider stop timed out after release was requested/u,
      ),
    });

    await workerService.stop();
    support.testState.service = undefined;
    closeOpenClawStateDatabaseForTest();
    support.testState.stateDb = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: support.testState.root },
    });
    support.testState.store = createWorkerEnvironmentStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    const restarted = support.createService(provider);
    restarted.start();
    await support.waitForFast(() =>
      expect(support.testState.store.get(pending.environmentId)).toMatchObject({
        state: "failed",
        leaseId: null,
      }),
    );

    expect(provision).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledWith({ leaseId, profile: { region: "test" } });
    expect(destroy).toHaveBeenCalledTimes(released ? 0 : 1);
    if (!released) {
      expect(destroy).toHaveBeenCalledWith({ leaseId, profile: { region: "test" } });
    }
    expect(support.testState.store.get(pending.environmentId)).toMatchObject({
      state: "failed",
      leaseId: null,
      teardownTerminalState: "failed",
      lastError: expect.stringMatching(
        /worker enrollment failed.*provider stop timed out after release was requested/u,
      ),
    });
  });

  it("does not resolve a provider provision timeout when the service override is set", async () => {
    const resolveProvisionTimeoutMs = vi.fn(() => {
      throw new Error("provider timeout hook must not run");
    });
    const workerService = support.createService(
      support.createProvider({ resolveProvisionTimeoutMs }),
      {
        providerCallTimeoutMs: 1_000,
      },
    );

    await expect(
      workerService.create("development", "request-provider-timeout-override"),
    ).resolves.toMatchObject({ state: "ready" });
    expect(resolveProvisionTimeoutMs).not.toHaveBeenCalled();
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["non-finite", Number.NaN],
    ["timer overflow", MAX_TIMER_TIMEOUT_MS + 1],
  ])("rejects a %s provider provision timeout before allocation", async (_label, timeoutMs) => {
    const provision = vi.fn(async () => ({
      leaseId: "lease-invalid-timeout",
      ssh: support.SSH_ENDPOINT,
    }));
    const workerService = support.createService(
      support.createProvider({
        provision,
        resolveProvisionTimeoutMs: () => timeoutMs,
      }),
    );

    await expect(
      workerService.create("development", `request-invalid-provider-timeout-${String(timeoutMs)}`),
    ).rejects.toMatchObject({
      code: "provider_failure",
      message: expect.stringContaining("Worker provider provision timeout must be an integer"),
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(provision).not.toHaveBeenCalled();
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "provisioning",
      leaseId: null,
    });
  });

  it("serializes allocation resolution and destroy behind a timed-out provider operation", async () => {
    const events: string[] = [];
    const operationIds: string[] = [];
    let active = 0;
    let maxActive = 0;
    let originalProvisionCalls = 0;
    let finishFirstProvision: (() => void) | undefined;
    const firstProvisionPending = new Promise<void>((resolve) => {
      finishFirstProvision = resolve;
    });
    const destroy = vi.fn(async () => {
      events.push("destroy:start");
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
      events.push("destroy:end");
    });
    const provider = support.createProvider({
      resolveAllocation: async () => {
        events.push("resolve");
        expect(active).toBe(0);
        return { leaseId: "lease-timeout-replay", sharedHost: false };
      },
      provision: async (_profile, operationId) => {
        originalProvisionCalls += 1;
        const call = originalProvisionCalls;
        operationIds.push(operationId);
        events.push(`provision:${call}:start`);
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (call === 1) {
          await firstProvisionPending;
        }
        active -= 1;
        events.push(`provision:${call}:end`);
        return { leaseId: "lease-timeout-replay", ssh: support.SSH_ENDPOINT };
      },
      destroy,
      resolveProvisionTimeoutMs: () => 20,
    });
    const workerService = support.createService(provider);
    const creation = workerService.create("development", "request-provider-timeout-race");
    const creationResult = expect(creation).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    let environmentId: string | undefined;
    let teardownResult: Promise<void> | undefined;
    try {
      await support.waitForFast(() => expect(events).toEqual(["provision:1:start"]));
      const queuedEnvironmentId = expectDefined(
        support.testState.store.list()[0],
        "timed-out provision row",
      ).environmentId;
      environmentId = queuedEnvironmentId;
      const teardown = workerService.destroy(queuedEnvironmentId);
      teardownResult = expect(teardown).resolves.toMatchObject({ state: "destroyed" });
      await creationResult;
      await support.waitForFast(() =>
        expect(
          support.testState.store.get(queuedEnvironmentId)?.destroyRequestedAtMs,
        ).not.toBeNull(),
      );
      expect(originalProvisionCalls).toBe(1);
      expect(destroy).not.toHaveBeenCalled();
      expect(maxActive).toBe(1);
    } finally {
      finishFirstProvision?.();
    }

    await teardownResult;
    const finalEnvironmentId = expectDefined(environmentId, "timed-out provision environment id");
    expect(operationIds).toHaveLength(1);
    expect(new Set(operationIds).size).toBe(1);
    expect(maxActive).toBe(1);
    expect(events).toEqual([
      "provision:1:start",
      "provision:1:end",
      "resolve",
      "destroy:start",
      "destroy:end",
    ]);
    expect(support.testState.store.get(finalEnvironmentId)).toMatchObject({ state: "destroyed" });
  });

  it("adopts an indeterminate allocation before a replay preparation failure", async () => {
    const events: string[] = [];
    let preparationFails = false;
    support.testState.prepareInstallation = vi.fn(async () => {
      events.push("prepare");
      if (preparationFails) {
        throw new Error("persisted bundle is unavailable");
      }
      return support.BUNDLE_ARTIFACT;
    });
    let provisionCalls = 0;
    const operationIds: string[] = [];
    const provider = support.createProvider({
      provision: async (_profile, operationId) => {
        events.push("provision");
        provisionCalls += 1;
        operationIds.push(operationId);
        if (provisionCalls === 1) {
          throw new Error("provision response was lost");
        }
        return { leaseId: "lease-replayed", ssh: support.SSH_ENDPOINT };
      },
      destroy: async () => void events.push("destroy"),
    });
    const workerService = support.createService(provider);

    await expect(
      workerService.create("development", "request-lost-provision"),
    ).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    preparationFails = true;
    await workerService.reconcileOnce();

    expect(events).toEqual(["prepare", "provision", "provision", "prepare", "destroy"]);
    expect(new Set(operationIds).size).toBe(1);
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "failed",
      leaseId: null,
      sshEndpoint: null,
      teardownTerminalState: "failed",
      lastError: "persisted bundle is unavailable",
    });
  });

  it.each([
    ["missing result", null, "invalid provision result"],
    ["missing transport", { leaseId: "lease-invalid" }, "invalid provision result"],
    [
      "ambiguous transport",
      { leaseId: "lease-invalid", ssh: support.SSH_ENDPOINT, node: { deviceId: "device-1" } },
      "invalid provision result",
    ],
    [
      "blank node device id",
      { leaseId: "lease-invalid", node: { deviceId: " " } },
      "invalid node device id",
    ],
    [
      "malformed SSH endpoint",
      { leaseId: "lease-invalid", ssh: { ...support.SSH_ENDPOINT, keyRef: "not-a-secret-ref" } },
      "SSH key must be a canonical SecretRef",
    ],
    [
      "excessive SSH fallback ports",
      {
        leaseId: "lease-invalid",
        ssh: {
          ...support.SSH_ENDPOINT,
          fallbackPorts: Array.from({ length: 11 }, (_, index) => 2300 + index),
        },
      },
      "SSH fallback ports cannot exceed 10",
    ],
    [
      "invalid shared-host declaration",
      { leaseId: "lease-invalid", ssh: support.SSH_ENDPOINT, sharedHost: "yes" },
      "invalid provision result",
    ],
    [
      "unsupported desktop protocol",
      {
        leaseId: "lease-invalid",
        ssh: support.SSH_ENDPOINT,
        desktop: { protocol: "rdp", port: 5900 },
      },
      'desktop protocol must be "rfb"',
    ],
    [
      "invalid desktop port",
      {
        leaseId: "lease-invalid",
        ssh: support.SSH_ENDPOINT,
        desktop: { protocol: "rfb", port: 0 },
      },
      "desktop port must be an integer",
    ],
    [
      "relative desktop password path",
      {
        leaseId: "lease-invalid",
        ssh: support.SSH_ENDPOINT,
        desktop: { protocol: "rfb", port: 5900, passwordFilePath: "vnc.password" },
      },
      "desktop password file path must be absolute",
    ],
    [
      "unrecognized desktop app metadata",
      {
        leaseId: "lease-invalid",
        ssh: support.SSH_ENDPOINT,
        desktop: {
          protocol: "rfb",
          port: 5900,
          apps: [
            {
              id: "browser",
              executablePath: "/usr/local/bin/openclaw-worker-browser",
              cdpPort: 9222,
              command: "chromium",
            },
          ],
        },
      },
      "browser desktop app contains unknown fields",
    ],
  ])("keeps %s from a provider retryable", async (_name, result, error) => {
    const workerService = support.createService(
      support.createProvider({ provision: async () => result as never }),
    );

    await expect(workerService.create("development", "request-malformed")).rejects.toMatchObject({
      code: "provider_failure",
      message: expect.stringContaining(error),
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "provisioning",
      lastError: expect.stringContaining(error),
    });
  });
});
