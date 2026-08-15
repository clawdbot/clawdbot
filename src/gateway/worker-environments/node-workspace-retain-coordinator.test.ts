import { describe, expect, it, vi } from "vitest";
import { NODE_WORKER_WORKSPACE_RETAIN_COMMAND } from "../../infra/node-commands.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import { createNodeWorkspaceRetainCoordinator } from "./node-workspace-retain-coordinator.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerEnvironmentService } from "./service.js";

const node = {
  nodeId: "node-1",
  connId: "connection-1",
  pairingIdentity: "pairing-1",
  pairingGeneration: "generation-1",
  clientId: "node-host",
  clientMode: "node",
  protocolFeature: "node-worker-supervisor-v1",
  commands: [],
} as const;

function environment(overrides: Record<string, unknown> = {}) {
  return {
    environmentId: "environment-1",
    providerId: "device",
    profileId: "device:node-1",
    profileSnapshot: { install: "bundle", settings: { device: "node-1" } },
    provisionOperationId: "provision-1",
    sharedHost: true,
    desktop: null,
    bootstrapReceipt: null,
    ownerEpoch: 7,
    teardownTerminalState: null,
    attachedSessionIds: ["session-1"],
    lastError: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
    idleSinceAtMs: null,
    destroyRequestedAtMs: null,
    state: "attached",
    leaseId: "device-lease",
    sshEndpoint: null,
    desktopAvailable: false,
    desktopApps: [],
    tunnelStatus: "connected",
    ...overrides,
  };
}

function placement(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    agentId: "main",
    sessionKey: "agent:main:session-1",
    generation: 3,
    turnClaim: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
    state: "active",
    environmentId: "environment-1",
    activeOwnerEpoch: 7,
    workspaceBaseManifestRef: `sha256:${"a".repeat(64)}`,
    remoteWorkspaceDir: "/node/workspace",
    workerBundleHash: "b".repeat(64),
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
    ...overrides,
  };
}

function createHarness(
  params: {
    environments?: unknown[];
    placements?: unknown[];
    results?: Array<{ applied: boolean; deleted: number; hasMore: boolean }>;
  } = {},
) {
  const results = [...(params.results ?? [{ applied: true, deleted: 0, hasMore: false }])];
  const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async () => ({
    ok: true,
    payloadJSON: JSON.stringify(results.shift() ?? { applied: true, deleted: 0, hasMore: false }),
  }));
  const transport: NodeWorkerSupervisorTransport = {
    listCurrentNodes: async () => [node],
    isCurrent: () => true,
    invoke,
  };
  const coordinator = createNodeWorkspaceRetainCoordinator({
    gatewayNamespace: "gateway-test",
    environments: {
      list: () => (params.environments ?? [environment()]) as never,
    } as Pick<WorkerEnvironmentService, "list">,
    placements: {
      list: () => (params.placements ?? [placement()]) as never,
    } as Pick<WorkerSessionPlacementStore, "list">,
    warn: vi.fn(),
  });
  coordinator.bindTransport(transport);
  return { coordinator, invoke };
}

describe("node workspace retain coordinator", () => {
  it("publishes the complete durable retain snapshot for a connected device", async () => {
    const { coordinator, invoke } = createHarness({
      environments: [
        environment(),
        environment({
          environmentId: "environment-other",
          profileSnapshot: { settings: { device: "node-other" } },
        }),
        environment({ environmentId: "environment-terminal", state: "orphaned" }),
      ],
    });

    await coordinator.start();

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      node,
      command: NODE_WORKER_WORKSPACE_RETAIN_COMMAND,
      params: {
        version: 1,
        gatewayNamespace: "gateway-test",
        controllerId: expect.any(String),
        sequence: 1,
        retain: [
          {
            environmentId: "environment-1",
            sessionId: "session-1",
            generation: 7,
            manifestRefs: [`sha256:${"a".repeat(64)}`],
          },
        ],
      },
    });
    await coordinator.stop();
  });

  it("retains all manifests while the durable placement is incomplete", async () => {
    const { coordinator, invoke } = createHarness({ placements: [] });

    await coordinator.start();

    expect(invoke.mock.calls[0]?.[0].params).toMatchObject({
      retain: [expect.objectContaining({ manifestRefs: null })],
    });
    await coordinator.stop();
  });

  it("continues bounded node cleanup with the same snapshot sequence", async () => {
    const { coordinator, invoke } = createHarness({
      results: [
        { applied: true, deleted: 256, hasMore: true },
        { applied: true, deleted: 1, hasMore: false },
      ],
    });

    await coordinator.start();

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]?.[0].params).toEqual(invoke.mock.calls[0]?.[0].params);
    await coordinator.stop();
  });

  it("republishes an identical full snapshot for reconnect-scoped inventory", async () => {
    const { coordinator, invoke } = createHarness();
    await coordinator.start();

    await coordinator.schedule("node-1");

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]?.[0].params).toMatchObject({ sequence: 2 });
    await coordinator.stop();
  });
});
