import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  type EnvironmentSummary,
} from "../../../packages/gateway-protocol/src/index.js";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import type { PairedDevice } from "../../infra/device-pairing.types.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import {
  bindDeviceWorkerAvailability,
  createDeviceWorkerRuntime,
} from "../worker-environments/device-provider.js";
import { createHarness } from "../worker-environments/placement-dispatch-test-harness.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { deriveEnvironmentIntent } from "../worker-environments/service-contract.js";
import * as environmentMethods from "./environments.js";
import {
  dispatchTestSessionId,
  dispatchTestSessionKey,
  getDispatchTestMocks,
  invokeSessionDispatch,
  makeDispatchTestContext,
  makeFailedPlacement,
  makeSessionTarget,
} from "./sessions-dispatch.test-support.js";

const dispatchTestMocks = getDispatchTestMocks();

function useDeviceSession(agentRuntimeOverride?: string): void {
  dispatchTestMocks.resolveTarget.mockReturnValue(
    makeSessionTarget({
      sessionId: dispatchTestSessionId,
      ...(agentRuntimeOverride
        ? {
            agentHarnessId: agentRuntimeOverride,
            agentRuntimeOverride,
            modelSelectionLocked: true,
            modelOverride: "gpt-test",
            providerOverride: "openai",
          }
        : {}),
      worktree: { id: "worktree-1", branch: "openclaw/device-test", repoRoot: "/repo" },
    }),
  );
  dispatchTestMocks.findLiveByOwner.mockReturnValue({
    id: "worktree-1",
    ownerKind: "session",
    ownerId: dispatchTestSessionKey,
  });
}

function pairedNode(deviceId: string): PairedDevice {
  return {
    deviceId,
    publicKey: `public-key-${deviceId}`,
    role: "node",
    roles: ["node"],
    tokens: {
      node: {
        token: "fixture-token",
        role: "node",
        scopes: [],
        createdAtMs: 1,
      },
    },
    createdAtMs: 1,
    approvedAtMs: 1,
  };
}

function connectedNode(deviceId: string, available: number) {
  return {
    nodeId: deviceId,
    connId: `conn-${deviceId}`,
    pairingIdentity: `identity-${deviceId}`,
    pairingGeneration: `generation-${deviceId}`,
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: { enabled: true, capacity: { total: Math.max(2, available), available } },
    commands: ["system.run"],
  } satisfies NodeWorkerSupervisorNodeProof;
}

function activeDevicePlacement(deviceId: string): WorkerSessionPlacementRecord {
  return {
    sessionId: dispatchTestSessionId,
    agentId: "main",
    sessionKey: dispatchTestSessionKey,
    executionMode: "worker-turn",
    state: "active",
    environmentId: `device-environment-${deviceId}`,
    generation: 1,
    activeOwnerEpoch: 2,
    workspaceBaseManifestRef: `sha256:${"a".repeat(64)}`,
    remoteWorkspaceDir: "/node/workspace",
    workerBundleHash: "b".repeat(64),
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
    turnClaim: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
  };
}

function deviceEnvironments(
  nodes: readonly ReturnType<typeof connectedNode>[],
): EnvironmentSummary[] {
  return nodes.map((node) => ({
    id: `node:${node.nodeId}`,
    type: "node" as const,
    status: "available" as const,
    sessionHost: true,
    workerSlots: { ...node.workerHost.capacity },
  }));
}

describe("sessions.dispatch device targets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchTestMocks.resolveTarget.mockReturnValue(makeSessionTarget());
  });

  it("synthesizes the core device-provider target for a connected session-capable node", async () => {
    useDeviceSession();
    const dispatch = vi.fn().mockResolvedValue(activeDevicePlacement("device-1"));
    const respond = await invokeSessionDispatch(
      makeDispatchTestContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
      { deviceId: "device-1" },
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "device:device-1",
        deviceId: "device-1",
        inheritedProfile: {
          providerId: "device",
          profileSnapshot: { install: "bundle", settings: { device: "device-1" } },
        },
      }),
      expect.any(Function),
      undefined,
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        placement: expect.objectContaining({ state: "active" }),
      }),
      undefined,
    );
  });

  it("returns a device dispatch failure to the operator", async () => {
    useDeviceSession();
    const dispatch = vi
      .fn()
      .mockRejectedValue(
        new Error("device worker node is not connected: device-1; reconnect it before retrying"),
      );
    const respond = await invokeSessionDispatch(
      makeDispatchTestContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
      { deviceId: "device-1" },
    );

    expect(dispatch).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
        message: expect.stringContaining("reconnect"),
      }),
    );
  });

  describe("automatic paired-device selection", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("dispatches to the highest-capacity eligible host and identifies it in the response", async () => {
      useDeviceSession();
      const nodes = [connectedNode("smaller", 1), connectedNode("largest", 4)];
      vi.spyOn(environmentMethods, "listGatewayEnvironments").mockResolvedValue(
        deviceEnvironments(nodes),
      );
      const dispatch = vi.fn().mockResolvedValue(activeDevicePlacement("largest"));
      const respond = await invokeSessionDispatch(
        makeDispatchTestContext({
          nodeRegistry: {
            get: (deviceId: string) => nodes.find((node) => node.nodeId === deviceId),
          } as never,
          workerPlacementDispatchService: { dispatch },
          workerSessionPlacementService: { getMany: () => new Map() },
        }),
        { autoDevice: true },
      );

      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: "device:largest", deviceId: "largest" }),
        expect.any(Function),
        undefined,
      );
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          placement: expect.objectContaining({
            runner: { kind: "device", status: "available", deviceId: "largest" },
          }),
        }),
        undefined,
      );
    });

    it.each([
      { autoDevice: true as const, profileId: "test" },
      { autoDevice: true as const, deviceId: "device-1" },
    ])("rejects automatic selection combined with an explicit target: %j", async (target) => {
      const dispatch = vi.fn();
      const respond = await invokeSessionDispatch(
        makeDispatchTestContext({
          workerPlacementDispatchService: { dispatch },
          workerSessionPlacementService: { getMany: () => new Map() },
        }),
        target,
      );

      expect(dispatch).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.INVALID_REQUEST,
          message: expect.stringMatching(/choose exactly one.*autoDevice.*deviceId.*profileId/i),
        }),
      );
    });

    it("explains how to recover when no paired node can host sessions", async () => {
      useDeviceSession();
      vi.spyOn(environmentMethods, "listGatewayEnvironments").mockResolvedValue([]);
      const dispatch = vi.fn();
      const respond = await invokeSessionDispatch(
        makeDispatchTestContext({
          nodeRegistry: { get: () => undefined } as never,
          workerPlacementDispatchService: { dispatch },
          workerSessionPlacementService: { getMany: () => new Map() },
        }),
        { autoDevice: true },
      );

      expect(dispatch).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.INVALID_REQUEST,
          message: expect.stringContaining("pair a node, enable session hosting"),
        }),
      );
    });

    it.each([
      { name: "disconnects", unavailableReason: "disconnected" as const },
      { name: "fills its worker slots", unavailableReason: "at-capacity" as const },
    ])(
      "tries the next host when the first $name before dispatch",
      async ({ unavailableReason }) => {
        useDeviceSession();
        const nodes = [connectedNode("first", 3), connectedNode("second", 2)];
        vi.spyOn(environmentMethods, "listGatewayEnvironments").mockResolvedValue(
          deviceEnvironments(nodes),
        );
        let firstChecks = 0;
        const workerEnvironmentService = { get: () => undefined };
        bindDeviceWorkerAvailability(workerEnvironmentService, async (deviceId) => {
          if (deviceId === "first" && ++firstChecks >= 2) {
            return unavailableReason === "disconnected"
              ? { available: false, unavailableReason }
              : { available: true, node: connectedNode(deviceId, 0) };
          }
          return { available: true, node: nodes.find((node) => node.nodeId === deviceId) };
        });
        const dispatch = vi.fn().mockResolvedValue(activeDevicePlacement("second"));

        const respond = await invokeSessionDispatch(
          makeDispatchTestContext({
            nodeRegistry: {
              get: (deviceId: string) => nodes.find((node) => node.nodeId === deviceId),
            } as never,
            workerEnvironmentService: workerEnvironmentService as never,
            workerPlacementDispatchService: { dispatch },
            workerSessionPlacementService: { getMany: () => new Map() },
          }),
          { autoDevice: true },
        );

        expect(dispatch).toHaveBeenCalledOnce();
        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({ profileId: "device:second", deviceId: "second" }),
          expect.any(Function),
          undefined,
        );
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            placement: expect.objectContaining({
              runner: { kind: "device", status: "available", deviceId: "second" },
            }),
          }),
          undefined,
        );
      },
    );

    it("redispatches to the next host when the first disappears at the inner eligibility fence", async () => {
      const root = await fs.mkdtemp(
        path.join(await fs.realpath(os.tmpdir()), "openclaw-session-auto-device-"),
      );
      try {
        const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
        const placements = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
        // A local row starts at generation one; failed and retried dispatches advance it twice.
        const harness = createHarness(placements, { environmentGeneration: 3 });
        const nodes = [connectedNode("first", 3), connectedNode("second", 2)];
        vi.spyOn(environmentMethods, "listGatewayEnvironments").mockResolvedValue(
          deviceEnvironments(nodes),
        );
        const firstChecks = { count: 0 };
        bindDeviceWorkerAvailability(harness.environments, async (deviceId) => {
          if (deviceId === "first" && ++firstChecks.count >= 4) {
            return { available: false, unavailableReason: "disconnected" };
          }
          return { available: true, node: nodes.find((node) => node.nodeId === deviceId) };
        });
        vi.mocked(harness.environments.createFromProfileSnapshot).mockResolvedValue({
          ...harness.ready,
          providerId: "device",
          profileId: "device:second",
          profileSnapshot: { install: "bundle", settings: { device: "second" } },
          nodeDeviceId: "second",
          sshEndpoint: null,
          sharedHost: true,
        });
        // attachSession resets the fixture environment; restamp the paired
        // device binding so the canonical runner reader can name the host.
        const attachSessionActual = vi
          .mocked(harness.environments.attachSession)
          .getMockImplementation();
        vi.mocked(harness.environments.attachSession).mockImplementation(async (...args) => {
          const minted = await attachSessionActual?.(...args);
          harness.markEnvironmentNodeDeviceId("second");
          return minted as Awaited<ReturnType<typeof harness.environments.attachSession>>;
        });
        dispatchTestMocks.resolveTarget.mockReturnValue(
          makeSessionTarget({
            sessionId: "session-1",
            worktree: { id: "worktree-1", branch: "openclaw/device-test", repoRoot: "/repo" },
          }),
        );
        dispatchTestMocks.findLiveByOwner.mockReturnValue({
          id: "worktree-1",
          ownerKind: "session",
          ownerId: dispatchTestSessionKey,
        });

        const respond = await invokeSessionDispatch(
          makeDispatchTestContext({
            nodeRegistry: {
              get: (deviceId: string) => nodes.find((node) => node.nodeId === deviceId),
            } as never,
            workerPlacementDispatchService: harness.service,
            workerSessionPlacementService: placements,
            workerEnvironmentService: harness.environments as never,
          }),
          { autoDevice: true },
        );

        const provisionCall = vi.mocked(harness.environments.createFromProfileSnapshot).mock
          .calls[0];
        expect(provisionCall?.[1]).toBe("session-dispatch:session-1:3");
        expect(harness.ready.environmentId).toBe(
          deriveEnvironmentIntent(provisionCall?.[1] ?? "missing").environmentId,
        );
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            placement: expect.objectContaining({
              runner: { kind: "device", status: "available", deviceId: "second" },
            }),
          }),
          undefined,
        );
        expect(harness.log).toEqual(
          expect.arrayContaining(["placement:requested", "placement:failed", "placement:active"]),
        );
        expect(harness.environments.createFromProfileSnapshot).toHaveBeenCalledOnce();
        expect(placements.get("session-1")).toMatchObject({ state: "active" });
      } finally {
        closeOpenClawStateDatabaseForTest();
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it("never attempts more than three hosts after they become ineligible", async () => {
      useDeviceSession();
      const nodes = ["first", "second", "third", "fourth"].map((id, index) =>
        connectedNode(id, 4 - index),
      );
      vi.spyOn(environmentMethods, "listGatewayEnvironments").mockResolvedValue(
        deviceEnvironments(nodes),
      );
      const disconnected = new Set<string>();
      const workerEnvironmentService = {};
      bindDeviceWorkerAvailability(workerEnvironmentService, async (deviceId) => {
        if (disconnected.has(deviceId)) {
          return { available: false, unavailableReason: "disconnected" };
        }
        return { available: true, node: nodes.find((node) => node.nodeId === deviceId) };
      });
      const dispatch = vi.fn(async (request: { deviceId?: string }) => {
        const deviceId = request.deviceId!;
        disconnected.add(deviceId);
        throw new Error(
          `device worker node is not connected: ${deviceId}; reconnect it before retrying`,
        );
      });
      const respond = await invokeSessionDispatch(
        makeDispatchTestContext({
          nodeRegistry: {
            get: (deviceId: string) => nodes.find((node) => node.nodeId === deviceId),
          } as never,
          workerEnvironmentService: workerEnvironmentService as never,
          workerPlacementDispatchService: { dispatch },
          workerSessionPlacementService: { getMany: () => new Map() },
        }),
        { autoDevice: true },
      );

      expect(dispatch.mock.calls.map(([request]) => request.deviceId)).toEqual([
        "first",
        "second",
        "third",
      ]);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.UNAVAILABLE,
          message: expect.stringMatching(/after 3.*reconnect/i),
        }),
      );
    });

    it("does not retry provisioning failures that are not eligibility errors", async () => {
      useDeviceSession();
      const nodes = [connectedNode("first", 3), connectedNode("second", 2)];
      vi.spyOn(environmentMethods, "listGatewayEnvironments").mockResolvedValue(
        deviceEnvironments(nodes),
      );
      const dispatch = vi.fn().mockRejectedValue(new Error("workspace synchronization failed"));
      const respond = await invokeSessionDispatch(
        makeDispatchTestContext({
          nodeRegistry: {
            get: (deviceId: string) => nodes.find((node) => node.nodeId === deviceId),
          } as never,
          workerPlacementDispatchService: { dispatch },
          workerSessionPlacementService: { getMany: () => new Map() },
        }),
        { autoDevice: true },
      );

      expect(dispatch).toHaveBeenCalledOnce();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.UNAVAILABLE,
          message: "workspace synchronization failed",
        }),
      );
    });

    it("never rotates to another host after an environment has been allocated", async () => {
      useDeviceSession();
      const nodes = [connectedNode("first", 3), connectedNode("second", 2)];
      vi.spyOn(environmentMethods, "listGatewayEnvironments").mockResolvedValue(
        deviceEnvironments(nodes),
      );
      let allocated = false;
      const workerEnvironmentService = {};
      bindDeviceWorkerAvailability(workerEnvironmentService, async (deviceId) =>
        allocated && deviceId === "first"
          ? { available: false, unavailableReason: "disconnected" }
          : { available: true, node: nodes.find((node) => node.nodeId === deviceId) },
      );
      const dispatch = vi.fn(async () => {
        allocated = true;
        throw new Error("device worker node is not connected: first; reconnect it before retrying");
      });

      const respond = await invokeSessionDispatch(
        makeDispatchTestContext({
          nodeRegistry: {
            get: (deviceId: string) => nodes.find((node) => node.nodeId === deviceId),
          } as never,
          workerEnvironmentService: workerEnvironmentService as never,
          workerPlacementDispatchService: { dispatch },
          workerSessionPlacementService: {
            getMany: () =>
              new Map(allocated ? [[dispatchTestSessionId, makeFailedPlacement()]] : []),
          } as never,
        }),
        { autoDevice: true },
      );

      expect(dispatch).toHaveBeenCalledOnce();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.UNAVAILABLE,
          message: expect.stringContaining("device worker node is not connected: first"),
        }),
      );
    });
  });

  describe("runtime-owned paired-node command authority", () => {
    let previousPluginRegistry: ReturnType<typeof getActivePluginRegistry>;

    beforeEach(() => {
      previousPluginRegistry = getActivePluginRegistry();
      setActivePluginRegistry(
        createEmptyPluginRegistry(),
        "sessions-dispatch-device-test",
        "default",
      );
      registerAgentHarness({
        id: "codex",
        label: "Codex",
        autoSelection: { providerIds: ["codex", "openai"] },
        cloudPlacement: {
          mode: "remote-exec",
          devicePlacement: {
            requiredNodeCommands: ["codex.exec-server.stdio.v2"],
            consumesWorkerSlot: false,
          },
        },
        supports: () => ({ supported: true, priority: 10 }),
        async runAttempt() {
          throw new Error("not used");
        },
      });
    });

    afterEach(() => {
      if (previousPluginRegistry) {
        setActivePluginRegistry(
          previousPluginRegistry,
          "sessions-dispatch-device-test-restore",
          "default",
        );
      } else {
        resetPluginRuntimeStateForTest();
      }
    });

    it.each([
      {
        name: "missing",
        declaredCommands: ["system.run"],
        commandPolicy: { allow: ["codex.exec-server.stdio.v2"] },
      },
      {
        name: "declared but denied",
        declaredCommands: ["system.run", "codex.exec-server.stdio.v2"],
        commandPolicy: { deny: ["codex.exec-server.stdio.v2"] },
      },
    ])("rejects a $name required paired-node command before dispatch", async (scenario) => {
      useDeviceSession("codex");
      const dispatch = vi.fn();
      const respond = await invokeSessionDispatch(
        makeDispatchTestContext({
          getRuntimeConfig: () => ({
            gateway: { nodes: { commands: scenario.commandPolicy } },
          }),
          nodeRegistry: {
            get: () => ({
              nodeId: "device-1",
              platform: "darwin",
              commands: scenario.declaredCommands,
              client: {},
            }),
          } as never,
          workerPlacementDispatchService: { dispatch },
          workerSessionPlacementService: { getMany: () => new Map() },
        }),
        { deviceId: "device-1" },
      );

      expect(dispatch).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.INVALID_REQUEST,
          message: expect.stringMatching(/command.*(enabled|approved|declared)/i),
        }),
      );
    });

    it.each([
      { name: "dispatches an opted-in runtime", runtimeId: "codex", supported: true },
      { name: "rejects a runtime without opt-in", runtimeId: "cloud-only", supported: false },
    ])("$name to a paired device", async ({ runtimeId, supported }) => {
      if (!supported) {
        registerAgentHarness({
          id: runtimeId,
          label: "Cloud only",
          cloudPlacement: { mode: "remote-exec" },
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("not used");
          },
        });
      }
      useDeviceSession(runtimeId);
      const dispatch = vi.fn().mockRejectedValue(new Error("paired-device dispatch reached"));
      const respond = await invokeSessionDispatch(
        makeDispatchTestContext({
          getRuntimeConfig: () => ({
            gateway: { nodes: { commands: { allow: ["codex.exec-server.stdio.v2"] } } },
          }),
          workerPlacementDispatchService: { dispatch },
          workerSessionPlacementService: { getMany: () => new Map() },
        }),
        { deviceId: "device-1" },
      );

      if (supported) {
        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            executionMode: "remote-exec",
            profileId: "device:device-1",
            deviceId: "device-1",
          }),
          expect.any(Function),
          undefined,
        );
      } else {
        expect(dispatch).not.toHaveBeenCalled();
      }
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: supported ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
          message: supported
            ? "paired-device dispatch reached"
            : "runtime cloud-only does not support paired-device placement; select a compatible runtime or cloud worker provider",
        }),
      );
    });

    it("carries runtime-owned node command requirements into cloud-profile dispatch", async () => {
      useDeviceSession("codex");
      const dispatch = vi.fn().mockRejectedValue(new Error("cloud-profile dispatch reached"));

      const respond = await invokeSessionDispatch(
        makeDispatchTestContext({
          getRuntimeConfig: () => ({
            cloudWorkers: { profiles: { test: { provider: "multimode-cloud" } } },
            gateway: { nodes: { commands: { allow: ["codex.exec-server.stdio.v2"] } } },
          }),
          workerPlacementDispatchService: { dispatch },
          workerSessionPlacementService: { getMany: () => new Map() },
        }),
      );

      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          executionMode: "remote-exec",
          profileId: "test",
          devicePlacement: {
            requiredNodeCommands: ["codex.exec-server.stdio.v2"],
            consumesWorkerSlot: false,
          },
        }),
        expect.any(Function),
        undefined,
      );
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.UNAVAILABLE,
          message: "cloud-profile dispatch reached",
        }),
      );
    });
  });

  it.each([
    {
      name: "full",
      nodes: [connectedNode("device-1", 0)],
      expectedMessage: "at capacity (all worker slots in use)",
      rejectedMessage: "reconnect",
    },
    {
      name: "disconnected",
      nodes: [],
      expectedMessage: "reconnect",
      rejectedMessage: "at capacity",
    },
  ])(
    "rejects a $name node before mutating placement or provisioning",
    async ({ nodes, expectedMessage, rejectedMessage }) => {
      const root = await fs.mkdtemp(
        path.join(await fs.realpath(os.tmpdir()), "openclaw-session-dispatch-device-"),
      );
      try {
        const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
        const placements = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
        const harness = createHarness(placements);
        const runtime = createDeviceWorkerRuntime({
          getPairedDevice: async (deviceId) => pairedNode(deviceId),
        });
        runtime.bindNodeTransport({
          listCurrentNodes: async () => nodes,
          hasCurrentRunner: () => nodes.length > 0,
          isCurrent: () => true,
          invoke: async () => ({ ok: false }),
        });
        bindDeviceWorkerAvailability(harness.environments, runtime.resolveAvailability);

        useDeviceSession();
        const respond = await invokeSessionDispatch(
          makeDispatchTestContext({
            workerPlacementDispatchService: harness.service,
            workerSessionPlacementService: placements,
            workerEnvironmentService: harness.environments as never,
          }),
          { deviceId: "device-1" },
        );

        const placement = placements.get(dispatchTestSessionId);
        expect(placement).toBeUndefined();
        expect(harness.environments.createFromProfileSnapshot).not.toHaveBeenCalled();
        expect(harness.environments.startTunnel).not.toHaveBeenCalled();
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: ErrorCodes.INVALID_REQUEST,
            message: expect.stringContaining(expectedMessage),
          }),
        );
        expect(respond).not.toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ message: expect.stringContaining(rejectedMessage) }),
        );
      } finally {
        closeOpenClawStateDatabaseForTest();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
