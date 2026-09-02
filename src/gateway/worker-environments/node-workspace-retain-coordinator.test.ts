import { describe, expect, it, vi } from "vitest";
import { NODE_WORKER_WORKSPACE_RETAIN_COMMAND } from "../../infra/node-commands.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import {
  NODE_WORKER_BUNDLE_RETAIN_MAX_HASHES,
  NODE_WORKER_RETAIN_REQUEST_MAX_BYTES,
} from "../../worker/node-workspace-retain-protocol.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import { createNodeWorkspaceRetainCoordinator } from "./node-workspace-retain-coordinator.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerEnvironmentService } from "./service.js";

type NodeWorkerBundleStatusObservation = NonNullable<
  ReturnType<NonNullable<NodeWorkerSupervisorTransport["getBundleStatus"]>>
>;

const node = {
  nodeId: "node-1",
  connId: "connection-1",
  pairingIdentity: "pairing-1",
  pairingGeneration: "generation-1",
  clientId: "node-host",
  clientMode: "node",
  protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  workerHost: {
    enabled: true,
    capacity: { total: 2, available: 2 },
    bundleRetention: 1,
    bundleStatus: 1,
  },
  commands: [],
} as const;

function environment(overrides: Record<string, unknown> = {}) {
  return {
    environmentId: "environment-1",
    providerId: "device",
    profileId: "device:node-1",
    profileSnapshot: { install: "bundle", settings: { device: "node-1" } },
    provisionOperationId: "provision-1",
    nodeSetupId: null,
    nodeDeviceId: "node-1",
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
    pendingResults?: ReturnType<WorkerSessionPlacementStore["listPendingWorkspaceResults"]>;
    results?: Array<{
      applied: boolean;
      deleted: number;
      hasMore: boolean;
      bundleGeneration?: number;
      bundleStatus?: { bundleHash: string; status: "installed" | "missing" };
    }>;
    node?: NodeWorkerSupervisorNodeProof;
    currentBundleStatus?: NodeWorkerBundleStatusObservation;
    invokeError?: string;
    onInvoke?: (index: number) => void;
  } = {},
) {
  const results = [...(params.results ?? [{ applied: true, deleted: 0, hasMore: false }])];
  let invokeIndex = 0;
  const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async () => {
    params.onInvoke?.(invokeIndex++);
    if (params.invokeError) {
      return { ok: false, error: { code: "UNAVAILABLE", message: params.invokeError } };
    }
    return {
      ok: true,
      payloadJSON: JSON.stringify(results.shift() ?? { applied: true, deleted: 0, hasMore: false }),
    };
  });
  let currentBundleStatus = params.currentBundleStatus;
  const acceptBundleStatus = vi.fn(
    (
      _node: NodeWorkerSupervisorNodeProof,
      observation: NodeWorkerBundleStatusObservation | undefined,
    ) => {
      currentBundleStatus = observation;
      return true;
    },
  );
  const transport: NodeWorkerSupervisorTransport = {
    hasCurrentRunner: () => false,
    listCurrentNodes: async () => [params.node ?? node],
    getBundleStatus: () => currentBundleStatus,
    acceptBundleStatus,
    isCurrent: () => true,
    invoke,
  };
  const warn = vi.fn();
  const coordinator = createNodeWorkspaceRetainCoordinator({
    gatewayNamespace: "gateway-test",
    environments: {
      list: () => (params.environments ?? [environment()]) as never,
    } as Pick<WorkerEnvironmentService, "list">,
    placements: {
      list: () => (params.placements ?? [placement()]) as never,
      listPendingWorkspaceResults: () => params.pendingResults ?? [],
    } as Pick<WorkerSessionPlacementStore, "list" | "listPendingWorkspaceResults">,
    warn,
  });
  coordinator.bindTransport(transport);
  return { coordinator, invoke, warn, acceptBundleStatus };
}

describe("node workspace retain coordinator", () => {
  it("publishes the complete durable retain snapshot for a connected device", async () => {
    const { coordinator, invoke } = createHarness({
      environments: [
        environment(),
        environment({
          environmentId: "environment-other",
          nodeDeviceId: "node-other",
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
        bundleHashes: ["b".repeat(64)],
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

  it("keeps prior retention nodes compatible without sending a status query", async () => {
    const { coordinator, invoke, acceptBundleStatus } = createHarness({
      node: {
        ...node,
        workerHost: {
          enabled: true,
          capacity: { total: 2, available: 2 },
          bundleRetention: 1,
        },
      },
      environments: [
        environment({
          bootstrapReceipt: {
            bundleHash: "b".repeat(64),
            openclawVersion: "2026.8.9",
            protocolFeatures: [],
            installKind: "bundle",
          },
        }),
      ],
    });

    await coordinator.start();

    expect(invoke.mock.calls[0]?.[0].params).toMatchObject({
      bundleHashes: ["b".repeat(64)],
    });
    expect(invoke.mock.calls[0]?.[0].params).not.toHaveProperty("bundleStatusHash");
    expect(acceptBundleStatus).toHaveBeenCalledWith(expect.any(Object), undefined);
    await coordinator.stop();
  });

  it("accepts a validated installed bundle status with the Gateway-owned version", async () => {
    const bundleHash = "b".repeat(64);
    const { coordinator, invoke, acceptBundleStatus } = createHarness({
      currentBundleStatus: {
        bundleHash,
        status: { status: "installed", version: "2026.8.9" },
      },
      environments: [
        environment({
          bootstrapReceipt: {
            bundleHash,
            openclawVersion: "2026.8.9",
            protocolFeatures: [],
            installKind: "bundle",
          },
        }),
      ],
      results: [
        {
          applied: true,
          deleted: 0,
          hasMore: false,
          bundleGeneration: 3,
          bundleStatus: { bundleHash, status: "installed" },
        },
      ],
    });

    await coordinator.start();

    expect(invoke.mock.calls[0]?.[0].params).toMatchObject({ bundleStatusHash: bundleHash });
    expect(acceptBundleStatus).toHaveBeenCalledWith(node, {
      bundleHash,
      status: { status: "installed", version: "2026.8.9" },
    });
    await coordinator.stop();
  });

  it("accepts status only from the final pass for the exact requested hash", async () => {
    const bundleHash = "b".repeat(64);
    const { coordinator, acceptBundleStatus } = createHarness({
      environments: [
        environment({
          bootstrapReceipt: {
            bundleHash,
            openclawVersion: "2026.8.9",
            protocolFeatures: [],
            installKind: "bundle",
          },
        }),
      ],
      results: [
        {
          applied: true,
          deleted: 1,
          hasMore: true,
          bundleStatus: { bundleHash, status: "installed" },
        },
        {
          applied: true,
          deleted: 0,
          hasMore: false,
          bundleStatus: { bundleHash, status: "missing" },
        },
      ],
    });

    await coordinator.start();

    expect(acceptBundleStatus).toHaveBeenCalledTimes(1);
    expect(acceptBundleStatus).toHaveBeenCalledWith(node, {
      bundleHash,
      status: { status: "missing" },
    });
    await coordinator.stop();
  });

  it("clears the previous hash before a new authoritative inspection can fail", async () => {
    const previousHash = "b".repeat(64);
    const currentHash = "c".repeat(64);
    const { coordinator, acceptBundleStatus, warn } = createHarness({
      currentBundleStatus: {
        bundleHash: previousHash,
        status: { status: "installed", version: "2026.8.8" },
      },
      environments: [
        environment({
          bootstrapReceipt: {
            bundleHash: currentHash,
            openclawVersion: "2026.8.9",
            protocolFeatures: [],
            installKind: "bundle",
          },
        }),
      ],
      invokeError: "maintenance unavailable",
    });

    await coordinator.start();

    expect(acceptBundleStatus).toHaveBeenCalledWith(node, undefined);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("maintenance unavailable"));
    await coordinator.stop();
  });

  it("clears status when a newer environment becomes authoritative during cleanup", async () => {
    const bundleHash = "b".repeat(64);
    const environments = [
      environment({
        bootstrapReceipt: {
          bundleHash,
          openclawVersion: "2026.8.9",
          protocolFeatures: [],
          installKind: "bundle",
        },
      }),
    ];
    const { coordinator, acceptBundleStatus } = createHarness({
      environments,
      results: [
        {
          applied: true,
          deleted: 1,
          hasMore: true,
          bundleStatus: { bundleHash, status: "installed" },
        },
        {
          applied: true,
          deleted: 0,
          hasMore: false,
          bundleStatus: { bundleHash, status: "installed" },
        },
      ],
      onInvoke: (index) => {
        if (index !== 0) {
          return;
        }
        environments.splice(
          0,
          1,
          environment({
            environmentId: "environment-new",
            createdAtMs: 3,
            bootstrapReceipt: {
              bundleHash: "c".repeat(64),
              openclawVersion: "2026.8.10",
              protocolFeatures: [],
              installKind: "bundle",
            },
          }),
        );
      },
    });

    await coordinator.start();

    expect(acceptBundleStatus).toHaveBeenCalledTimes(1);
    expect(acceptBundleStatus).toHaveBeenCalledWith(node, undefined);
    await coordinator.stop();
  });

  it("clears status when the node echoes a different bundle hash", async () => {
    const bundleHash = "b".repeat(64);
    const { coordinator, acceptBundleStatus } = createHarness({
      environments: [
        environment({
          bootstrapReceipt: {
            bundleHash,
            openclawVersion: "2026.8.9",
            protocolFeatures: [],
            installKind: "bundle",
          },
        }),
      ],
      results: [
        {
          applied: true,
          deleted: 0,
          hasMore: false,
          bundleStatus: { bundleHash: "c".repeat(64), status: "installed" },
        },
      ],
    });

    await coordinator.start();

    expect(acceptBundleStatus).toHaveBeenCalledWith(node, undefined);
    await coordinator.stop();
  });

  it("keeps workspace retention compatible when bundle cleanup is not advertised", async () => {
    const { coordinator, invoke } = createHarness({
      node: {
        ...node,
        workerHost: { enabled: true, capacity: { total: 2, available: 2 } },
      },
    });

    await coordinator.start();

    expect(invoke.mock.calls[0]?.[0].params).not.toHaveProperty("bundleHashes");
    await coordinator.stop();
  });

  it("fails safe to workspace-only retention when bundle ownership exceeds the wire bound", async () => {
    const environments = Array.from(
      { length: NODE_WORKER_BUNDLE_RETAIN_MAX_HASHES + 1 },
      (_, index) =>
        environment({
          environmentId: `environment-${index}`,
          attachedSessionIds: [],
          bootstrapReceipt: {
            bundleHash: index.toString(16).padStart(64, "0"),
            openclawVersion: "2026.8.1",
            protocolFeatures: [],
            installKind: "bundle",
          },
        }),
    );
    const { coordinator, invoke, warn } = createHarness({ environments, placements: [] });

    await coordinator.start();

    expect(invoke.mock.calls[0]?.[0].params).not.toHaveProperty("bundleHashes");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("exceed the bounded maintenance request"),
    );
    await coordinator.stop();
  });

  it("keeps bounded bundle retention when only the status query exceeds one MiB", async () => {
    const attachedCount = 1_241;
    const environments = Array.from(
      { length: NODE_WORKER_BUNDLE_RETAIN_MAX_HASHES },
      (_, index) => {
        const suffix = index.toString(16).padStart(8, "0");
        const attached = index < attachedCount;
        const environmentPadding =
          index < attachedCount - 1 ? 220 : index === attachedCount - 1 ? 31 : 0;
        const sessionPadding =
          index < attachedCount - 1 ? 224 : index === attachedCount - 1 ? 31 : 0;
        return environment({
          environmentId: `environment-${"e".repeat(environmentPadding)}-${suffix}`,
          attachedSessionIds: attached ? [`session-${"s".repeat(sessionPadding)}-${suffix}`] : [],
          createdAtMs: index === NODE_WORKER_BUNDLE_RETAIN_MAX_HASHES - 1 ? 10 : 1,
          bootstrapReceipt: {
            bundleHash: index.toString(16).padStart(64, "0"),
            openclawVersion: "2026.8.9",
            protocolFeatures: [],
            installKind: "bundle",
          },
        });
      },
    );
    const placements = environments.slice(0, attachedCount).map((entry, index) =>
      placement({
        sessionId: entry.attachedSessionIds[0],
        environmentId: entry.environmentId,
        workerBundleHash: index.toString(16).padStart(64, "0"),
      }),
    );
    const { coordinator, invoke, warn } = createHarness({ environments, placements });

    await coordinator.start();

    const input = invoke.mock.calls[0]?.[0].params as Record<string, unknown>;
    expect(input.bundleHashes).toHaveLength(NODE_WORKER_BUNDLE_RETAIN_MAX_HASHES);
    expect(input).not.toHaveProperty("bundleStatusHash");
    expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBeLessThanOrEqual(
      NODE_WORKER_RETAIN_REQUEST_MAX_BYTES,
    );
    expect(
      Buffer.byteLength(
        JSON.stringify({
          ...input,
          bundleStatusHash: (NODE_WORKER_BUNDLE_RETAIN_MAX_HASHES - 1)
            .toString(16)
            .padStart(64, "0"),
        }),
        "utf8",
      ),
    ).toBeGreaterThan(NODE_WORKER_RETAIN_REQUEST_MAX_BYTES);
    expect(warn).not.toHaveBeenCalled();
    await coordinator.stop();
  });

  it("omits bundle hashes when the combined maintenance request exceeds one MiB", async () => {
    const environments = Array.from(
      { length: NODE_WORKER_BUNDLE_RETAIN_MAX_HASHES },
      (_, index) => {
        const suffix = index.toString(16).padStart(8, "0");
        const attached = index < 1_500;
        return environment({
          environmentId: `environment-${"e".repeat(220)}-${suffix}`,
          attachedSessionIds: attached ? [`session-${"s".repeat(224)}-${suffix}`] : [],
          bootstrapReceipt: {
            bundleHash: index.toString(16).padStart(64, "0"),
            openclawVersion: "2026.8.1",
            protocolFeatures: [],
            installKind: "bundle",
          },
        });
      },
    );
    const placements = environments.slice(0, 1_500).map((entry, index) =>
      placement({
        sessionId: entry.attachedSessionIds[0],
        environmentId: entry.environmentId,
        workerBundleHash: index.toString(16).padStart(64, "0"),
      }),
    );
    const { coordinator, invoke, warn } = createHarness({ environments, placements });

    await coordinator.start();

    expect(invoke.mock.calls[0]?.[0].params).not.toHaveProperty("bundleHashes");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("exceed the bounded maintenance request"),
    );
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

  it.each(["claimed", "pending", "stale-pending"])(
    "protects unsettled manifests for %s ownership",
    async (state) => {
      const { coordinator, invoke } = createHarness({
        placements: [
          placement({
            turnClaim:
              state === "claimed"
                ? {
                    owner: "worker",
                    claimId: "claim-1",
                    runId: "run-1",
                    generation: 3,
                    ownerEpoch: 7,
                  }
                : null,
          }),
        ],
        pendingResults:
          state === "claimed"
            ? []
            : [
                {
                  sessionId: "session-1",
                  environmentId: "environment-1",
                  ownerEpoch: state === "pending" ? 7 : 6,
                  placementGeneration: 3,
                  claimId: "claim-1",
                  runId: "run-1",
                  gatewayInstanceId: "previous-gateway",
                  recoveryRequestedAtMs: null,
                  workspaceAcceptedAtMs: null,
                  stagedResultRef: null,
                },
              ],
      });
      await coordinator.start();
      expect(invoke.mock.calls[0]?.[0].params).toMatchObject({
        retain: [
          expect.objectContaining({
            manifestRefs: state === "stale-pending" ? [`sha256:${"a".repeat(64)}`] : null,
          }),
        ],
      });
      await coordinator.stop();
    },
  );

  it("acknowledges the node bundle generation on the next same-connection snapshot", async () => {
    const { coordinator, invoke } = createHarness({
      results: [
        {
          applied: true,
          deleted: 0,
          hasMore: false,
          bundleGeneration: 7,
        },
        {
          applied: true,
          deleted: 0,
          hasMore: false,
          bundleGeneration: 7,
        },
      ],
    });

    await coordinator.start();
    await coordinator.schedule("node-1");

    expect(invoke.mock.calls[0]?.[0].params).not.toHaveProperty("acknowledgedBundleGeneration");
    expect(invoke.mock.calls[1]?.[0].params).toMatchObject({
      acknowledgedBundleGeneration: 7,
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
