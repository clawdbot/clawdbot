import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NODE_WORKER_SUPERVISOR_STATUS_COMMAND } from "../../infra/node-commands.js";
import {
  NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
} from "../../infra/node-runner-inventory.js";
import {
  collectNodeWorkerBundleStatusByNodeId,
  collectNodeWorkerCapacityByNodeId,
  createNodeRegistryRuntime,
  setNodeRunnerStateChangedListener,
} from "../node-registry-private.js";
import { NodeRegistry } from "../node-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { nodeHandlers } from "./nodes.js";
import { createWorkerSupervisorNodeClient } from "./nodes.runner-inventory.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type UpdatePairedNodeSessionHostParams = Parameters<
  typeof import("../../infra/device-pairing-node-facts.js").updatePairedNodeSessionHost
>[0];

const updatePairedNodeSessionHostMock = vi.hoisted(() =>
  vi.fn(async (_params: UpdatePairedNodeSessionHostParams): Promise<boolean> => true),
);

vi.mock("../../infra/device-pairing-node-facts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/device-pairing-node-facts.js")>()),
  updatePairedNodeSessionHost: updatePairedNodeSessionHostMock,
}));

const RETIRED_WORKER_RUNS = { retired: true } as const;
const AVAILABLE_CAPACITY = { total: 2, available: 2 } as const;
const FULL_CAPACITY = { total: 2, available: 0 } as const;

function runnerInventoryOptions(params: {
  nodeRegistry: NodeRegistry;
  client: GatewayWsClient;
  declaration: unknown;
}): GatewayRequestHandlerOptions {
  return {
    req: {
      type: "req",
      id: "req-1",
      method: "node.runnerInventory.update",
      params: params.declaration,
    },
    params: params.declaration,
    client: params.client as never,
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: { nodeRegistry: params.nodeRegistry, logGateway: { warn: vi.fn() } },
  } as unknown as GatewayRequestHandlerOptions;
}

const runnerInventoryHandler = expectDefined(
  nodeHandlers["node.runnerInventory.update"],
  'nodeHandlers["node.runnerInventory.update"] test invariant',
);

const availableHost = {
  protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
  workerHost: { enabled: true, capacity: AVAILABLE_CAPACITY, bundlePrewarm: 1 },
} as const;

const fullHost = {
  protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
  workerHost: { enabled: true, capacity: FULL_CAPACITY, bundlePrewarm: 1 },
} as const;

const retainedHost = {
  protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
  workerHost: {
    enabled: true,
    capacity: AVAILABLE_CAPACITY,
    bundlePrewarm: 1,
    bundleRetention: 1,
    bundleStatus: 1,
  },
} as const;

beforeEach(() => {
  updatePairedNodeSessionHostMock.mockReset();
  updatePairedNodeSessionHostMock.mockResolvedValue(true);
});

describe("nodeHandlers node.runnerInventory.update", () => {
  it("publishes explicit runner consent and launch capacity for the authenticated node", async () => {
    const inventoryChanged = vi.fn();
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    setNodeRunnerStateChangedListener(runtime.nodeRegistry, inventoryChanged);
    const client = createWorkerSupervisorNodeClient();
    runtime.nodeRegistry.register(client, {
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
    });
    const opts = runnerInventoryOptions({
      nodeRegistry: runtime.nodeRegistry,
      client,
      declaration: availableHost,
    });

    await runnerInventoryHandler(opts);

    expect(opts.respond).toHaveBeenCalledWith(true, { nodeId: "node-1" }, undefined);
    expect(updatePairedNodeSessionHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "node-1",
        sessionHost: true,
        expectedPairingGeneration: { nodeId: "node-1", key: "generation-1" },
      }),
    );
    expect(inventoryChanged).toHaveBeenCalledWith("node-1", {
      inventoryChanged: true,
      availabilityChanged: true,
    });
    await expect(runtime.nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([
      expect.objectContaining({
        nodeId: "node-1",
        connId: "conn-1",
        pairingGeneration: "generation-1",
        workerHost: { enabled: true, capacity: AVAILABLE_CAPACITY, bundlePrewarm: 1 },
      }),
    ]);
    expect(
      collectNodeWorkerCapacityByNodeId(runtime.nodeRegistry, [
        { nodeId: "node-1", connId: "conn-1" },
      ]),
    ).toEqual(new Map([["node-1", AVAILABLE_CAPACITY]]));
    runtime.nodeRegistry.unregister("conn-1");
  });

  it("stores bundle status only for the exact current node proof", async () => {
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    const client = createWorkerSupervisorNodeClient();
    runtime.nodeRegistry.register(client, {
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
    });
    await runnerInventoryHandler(
      runnerInventoryOptions({
        nodeRegistry: runtime.nodeRegistry,
        client,
        declaration: retainedHost,
      }),
    );
    const [proof] = await runtime.nodeWorkerSupervisorTransport.listCurrentNodes();
    if (!proof) {
      throw new Error("expected current node proof");
    }

    expect(
      runtime.nodeWorkerSupervisorTransport.acceptBundleStatus?.(proof, {
        bundleHash: "a".repeat(64),
        status: { status: "installed", version: "2026.8.9" },
      }),
    ).toBe(true);
    expect(runtime.nodeWorkerSupervisorTransport.getBundleStatus?.("node-1")).toEqual({
      bundleHash: "a".repeat(64),
      status: { status: "installed", version: "2026.8.9" },
    });
    expect(
      collectNodeWorkerBundleStatusByNodeId(runtime.nodeRegistry, [
        { nodeId: "node-1", connId: "conn-1" },
      ]),
    ).toEqual(new Map([["node-1", { status: "installed", version: "2026.8.9" }]]));

    expect(
      runtime.nodeRegistry.updateSurface(
        "node-1",
        { commands: ["system.run"] },
        {
          expectedConnId: "conn-1",
          expectedPairingIdentity: "identity-1",
          expectedPairingGeneration: "generation-1",
          nextPairingGeneration: "generation-2",
        },
      ),
    ).not.toBeNull();
    expect(
      runtime.nodeWorkerSupervisorTransport.acceptBundleStatus?.(proof, {
        bundleHash: "b".repeat(64),
        status: { status: "missing" },
      }),
    ).toBe(false);
    expect(
      collectNodeWorkerBundleStatusByNodeId(runtime.nodeRegistry, [
        { nodeId: "node-1", connId: "conn-1" },
      ]),
    ).toEqual(new Map());

    await runnerInventoryHandler(
      runnerInventoryOptions({
        nodeRegistry: runtime.nodeRegistry,
        client,
        declaration: retainedHost,
      }),
    );
    const [currentProof] = await runtime.nodeWorkerSupervisorTransport.listCurrentNodes();
    if (!currentProof) {
      throw new Error("expected promoted node proof");
    }
    expect(
      runtime.nodeWorkerSupervisorTransport.acceptBundleStatus?.(currentProof, {
        bundleHash: "b".repeat(64),
        status: { status: "missing" },
      }),
    ).toBe(true);
    await runnerInventoryHandler(
      runnerInventoryOptions({
        nodeRegistry: runtime.nodeRegistry,
        client,
        declaration: availableHost,
      }),
    );
    expect(
      runtime.nodeWorkerSupervisorTransport.acceptBundleStatus?.(currentProof, {
        bundleHash: "c".repeat(64),
        status: { status: "installed", version: "2026.8.9" },
      }),
    ).toBe(false);
    expect(
      collectNodeWorkerBundleStatusByNodeId(runtime.nodeRegistry, [
        { nodeId: "node-1", connId: "conn-1" },
      ]),
    ).toEqual(new Map());

    runtime.nodeRegistry.unregister("conn-1");
    expect(
      collectNodeWorkerBundleStatusByNodeId(runtime.nodeRegistry, [
        { nodeId: "node-1", connId: "conn-1" },
      ]),
    ).toEqual(new Map());
  });

  it("retains the supervisor proof while full but rejects new launches", async () => {
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    const client = createWorkerSupervisorNodeClient();
    runtime.nodeRegistry.register(client, {
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
    });
    const publish = async (declaration: unknown) => {
      const opts = runnerInventoryOptions({
        nodeRegistry: runtime.nodeRegistry,
        client,
        declaration,
      });
      await runnerInventoryHandler(opts);
      expect(opts.respond).toHaveBeenCalledWith(true, { nodeId: "node-1" }, undefined);
    };

    await publish(availableHost);
    await publish(fullHost);

    const [proof] = await runtime.nodeWorkerSupervisorTransport.listCurrentNodes();
    expect(proof?.workerHost).toEqual({
      enabled: true,
      capacity: FULL_CAPACITY,
      bundlePrewarm: 1,
    });
    expect(proof && runtime.nodeWorkerSupervisorTransport.isCurrent(proof)).toBe(true);
    expect(proof && runtime.nodeWorkerSupervisorTransport.isCurrent(proof, true)).toBe(false);
    runtime.nodeRegistry.unregister("conn-1");
  });

  it("does not notify for an identical inventory publication", async () => {
    const inventoryChanged = vi.fn();
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    setNodeRunnerStateChangedListener(runtime.nodeRegistry, inventoryChanged);
    const client = createWorkerSupervisorNodeClient();
    runtime.nodeRegistry.register(client, {
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
    });
    const first = runnerInventoryOptions({
      nodeRegistry: runtime.nodeRegistry,
      client,
      declaration: availableHost,
    });
    const second = runnerInventoryOptions({
      nodeRegistry: runtime.nodeRegistry,
      client,
      declaration: availableHost,
    });

    await runnerInventoryHandler(first);
    await runnerInventoryHandler(second);

    expect(inventoryChanged).toHaveBeenCalledTimes(1);
    runtime.nodeRegistry.unregister("conn-1");
  });

  it("requires a fresh current-generation publication after same-connection promotion", async () => {
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    const client = createWorkerSupervisorNodeClient();
    runtime.nodeRegistry.register(client, { pairingIdentity: "identity-1" });
    const opts = runnerInventoryOptions({
      nodeRegistry: runtime.nodeRegistry,
      client,
      declaration: fullHost,
    });

    await runnerInventoryHandler(opts);
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
    await expect(runtime.nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([]);

    expect(
      runtime.nodeRegistry.updateSurface(
        "node-1",
        { commands: ["system.run"] },
        {
          expectedConnId: "conn-1",
          expectedPairingIdentity: "identity-1",
          nextPairingGeneration: "generation-1",
        },
      ),
    ).not.toBeNull();
    await expect(runtime.nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([]);

    const retry = runnerInventoryOptions({
      nodeRegistry: runtime.nodeRegistry,
      client,
      declaration: fullHost,
    });
    await runnerInventoryHandler(retry);
    expect(retry.respond).toHaveBeenCalledWith(true, { nodeId: "node-1" }, undefined);
    await expect(runtime.nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([
      expect.objectContaining({
        pairingGeneration: "generation-1",
        workerHost: { enabled: true, capacity: FULL_CAPACITY, bundlePrewarm: 1 },
      }),
    ]);
    runtime.nodeRegistry.unregister("conn-1");
  });

  it("persists false for current disabled and empty publications", async () => {
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    const client = createWorkerSupervisorNodeClient();
    runtime.nodeRegistry.register(client, {
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
    });

    await runnerInventoryHandler(
      runnerInventoryOptions({
        nodeRegistry: runtime.nodeRegistry,
        client,
        declaration: {
          protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
          workerHost: { enabled: false },
        },
      }),
    );
    await runnerInventoryHandler(
      runnerInventoryOptions({
        nodeRegistry: runtime.nodeRegistry,
        client,
        declaration: { protocolFeatures: [] },
      }),
    );

    expect(
      updatePairedNodeSessionHostMock.mock.calls.map(([params]) => params.sessionHost),
    ).toEqual([false, false]);
    runtime.nodeRegistry.unregister("conn-1");
  });

  it("returns a retryable failure when durable consent does not commit", async () => {
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    const client = createWorkerSupervisorNodeClient();
    runtime.nodeRegistry.register(client, {
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
    });
    updatePairedNodeSessionHostMock.mockRejectedValueOnce(new Error("database busy"));
    const first = runnerInventoryOptions({
      nodeRegistry: runtime.nodeRegistry,
      client,
      declaration: availableHost,
    });

    await runnerInventoryHandler(first);
    expect(first.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", message: expect.stringContaining("retry") }),
    );

    const retry = runnerInventoryOptions({
      nodeRegistry: runtime.nodeRegistry,
      client,
      declaration: availableHost,
    });
    await runnerInventoryHandler(retry);
    expect(retry.respond).toHaveBeenCalledWith(true, { nodeId: "node-1" }, undefined);
    expect(updatePairedNodeSessionHostMock).toHaveBeenCalledTimes(2);
    runtime.nodeRegistry.unregister("conn-1");
  });

  it("rejects durable consent after a same-generation connection replacement", async () => {
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    const client = createWorkerSupervisorNodeClient("conn-original");
    runtime.nodeRegistry.register(client, {
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
    });
    const replacement = createWorkerSupervisorNodeClient("conn-replacement");
    updatePairedNodeSessionHostMock.mockImplementationOnce(async (params) => {
      runtime.nodeRegistry.register(replacement, {
        pairingIdentity: "identity-1",
        pairingGeneration: "generation-1",
      });
      return params.isConnectionCurrent();
    });
    const publication = runnerInventoryOptions({
      nodeRegistry: runtime.nodeRegistry,
      client,
      declaration: availableHost,
    });

    await runnerInventoryHandler(publication);

    expect(publication.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", message: expect.stringContaining("retry") }),
    );
    runtime.nodeRegistry.unregister("conn-replacement");
  });

  it("keeps retired v1 inventory diagnostic-only until disconnect and v6 reconnect", async () => {
    const inventoryChanged = vi.fn();
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    setNodeRunnerStateChangedListener(runtime.nodeRegistry, inventoryChanged);
    const legacyClient = createWorkerSupervisorNodeClient("conn-v1");
    runtime.nodeRegistry.register(legacyClient, {
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
    });
    const legacy = runnerInventoryOptions({
      nodeRegistry: runtime.nodeRegistry,
      client: legacyClient,
      declaration: {
        protocolFeatures: ["node-worker-supervisor-v1"],
        workerRuns: RETIRED_WORKER_RUNS,
      },
    });

    await runnerInventoryHandler(legacy);

    expect(legacy.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("openclaw update"),
      }),
    );
    expect(inventoryChanged).toHaveBeenLastCalledWith("node-1", {
      inventoryChanged: true,
      availabilityChanged: false,
    });
    expect(runtime.nodeWorkerSupervisorTransport.getIssue?.("node-1")).toEqual(
      NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
    );
    expect(updatePairedNodeSessionHostMock).not.toHaveBeenCalled();
    await expect(runtime.nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([]);
    const forgedProof = {
      nodeId: "node-1",
      connId: "conn-v1",
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
      clientId: "node-host",
      clientMode: "node",
      protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
      workerHost: { enabled: true, capacity: AVAILABLE_CAPACITY, bundlePrewarm: 1 },
      commands: ["system.run"],
    } as const;
    expect(runtime.nodeWorkerSupervisorTransport.isCurrent(forgedProof)).toBe(false);
    await expect(
      runtime.nodeWorkerSupervisorTransport.invoke({
        node: forgedProof,
        command: NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
        isDispatchAuthorized: () => true,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "PRIVATE_DIALECT_UNAVAILABLE" } });

    runtime.nodeRegistry.unregister("conn-v1");
    expect(runtime.nodeWorkerSupervisorTransport.getIssue?.("node-1")).toBeUndefined();
    expect(inventoryChanged).toHaveBeenCalledTimes(2);

    const currentClient = createWorkerSupervisorNodeClient("conn-v6");
    runtime.nodeRegistry.register(currentClient, {
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
    });
    await runnerInventoryHandler(
      runnerInventoryOptions({
        nodeRegistry: runtime.nodeRegistry,
        client: currentClient,
        declaration: availableHost,
      }),
    );
    expect(runtime.nodeWorkerSupervisorTransport.getIssue?.("node-1")).toBeUndefined();
    await expect(runtime.nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([
      expect.objectContaining({
        nodeId: "node-1",
        connId: "conn-v6",
        workerHost: { enabled: true, capacity: AVAILABLE_CAPACITY, bundlePrewarm: 1 },
      }),
    ]);
    runtime.nodeRegistry.unregister("conn-v6");
  });

  it.each([
    [
      "v1 with an opaque workerRuns value",
      {
        protocolFeatures: ["node-worker-supervisor-v1"],
        workerRuns: RETIRED_WORKER_RUNS,
      },
    ],
    [
      "v2 with an opaque workerHost value",
      {
        protocolFeatures: ["node-worker-supervisor-v2"],
        workerHost: null,
      },
    ],
    ["v3 marker without a payload", { protocolFeatures: ["node-worker-supervisor-v3"] }],
    [
      "v4 with an opaque workerRuns value",
      {
        protocolFeatures: ["node-worker-supervisor-v4"],
        workerRuns: "retired payload",
      },
    ],
    [
      "v5 with an opaque workerHost value",
      {
        protocolFeatures: ["node-worker-supervisor-v5"],
        workerHost: { enabled: "retired" },
      },
    ],
  ] as const)("routes the retired %s inventory to update recovery", async (_name, declaration) => {
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    const client = createWorkerSupervisorNodeClient();
    runtime.nodeRegistry.register(client, {
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
    });
    const opts = runnerInventoryOptions({
      nodeRegistry: runtime.nodeRegistry,
      client,
      declaration,
    });

    await runnerInventoryHandler(opts);

    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("openclaw update") }),
    );
    expect(runtime.nodeWorkerSupervisorTransport.getIssue?.("node-1")).toEqual(
      NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
    );
    expect(updatePairedNodeSessionHostMock).not.toHaveBeenCalled();
    await expect(runtime.nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([]);
    runtime.nodeRegistry.unregister("conn-1");
  });

  it.each([
    { name: "missing list", params: {} },
    { name: "extra key", params: { protocolFeatures: [], extra: true } },
    { name: "non-array", params: { protocolFeatures: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } },
    {
      name: "too many",
      params: {
        protocolFeatures: [
          NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
          NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
        ],
      },
    },
    { name: "wrong dialect", params: { protocolFeatures: ["node-worker-supervisor-v0"] } },
    { name: "unknown future dialect", params: { protocolFeatures: ["node-worker-supervisor-v7"] } },
    {
      name: "mixed retired and current dialects",
      params: {
        protocolFeatures: ["node-worker-supervisor-v5", NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
      },
    },
    {
      name: "retired dialect with an extra key",
      params: { protocolFeatures: ["node-worker-supervisor-v1"], extra: true },
    },
    {
      name: "retired dialect with both legacy payload keys",
      params: {
        protocolFeatures: ["node-worker-supervisor-v5"],
        workerRuns: RETIRED_WORKER_RUNS,
        workerHost: { enabled: true },
      },
    },
    {
      name: "missing current worker host",
      params: { protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE] },
    },
    {
      name: "legacy build on current dialect",
      params: {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerRuns: RETIRED_WORKER_RUNS,
      },
    },
    {
      name: "disabled host with capacity",
      params: {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: { enabled: false, capacity: FULL_CAPACITY },
      },
    },
    {
      name: "enabled host without capacity",
      params: {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: { enabled: true },
      },
    },
    {
      name: "binary capacity on current dialect",
      params: {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: { enabled: true, capacity: "available" },
      },
    },
    {
      name: "zero total capacity",
      params: {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: { enabled: true, capacity: { total: 0, available: 0 } },
      },
    },
    {
      name: "available capacity above total",
      params: {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: { enabled: true, capacity: { total: 2, available: 3 } },
      },
    },
    {
      name: "capacity with extra field",
      params: {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: { enabled: true, capacity: { total: 2, available: 2, busy: 0 } },
      },
    },
    {
      name: "unsupported bundle prewarm version",
      params: {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: { enabled: true, capacity: AVAILABLE_CAPACITY, bundlePrewarm: 2 },
      },
    },
    {
      name: "unsupported bundle retention version",
      params: {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: { enabled: true, capacity: AVAILABLE_CAPACITY, bundleRetention: 2 },
      },
    },
    {
      name: "unsupported bundle status version",
      params: {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: { enabled: true, capacity: AVAILABLE_CAPACITY, bundleStatus: 2 },
      },
    },
    {
      name: "bundle status without bundle retention",
      params: {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: { enabled: true, capacity: AVAILABLE_CAPACITY, bundleStatus: 1 },
      },
    },
  ])("rejects $name without changing private eligibility", async ({ params }) => {
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    const client = createWorkerSupervisorNodeClient();
    runtime.nodeRegistry.register(client, {
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
    });
    const opts = runnerInventoryOptions({
      nodeRegistry: runtime.nodeRegistry,
      client,
      declaration: params,
    });

    await runnerInventoryHandler(opts);

    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(runtime.nodeWorkerSupervisorTransport.getIssue?.("node-1")).toBeUndefined();
    expect(updatePairedNodeSessionHostMock).not.toHaveBeenCalled();
    await expect(runtime.nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([]);
    runtime.nodeRegistry.unregister("conn-1");
  });

  it("rejects a stale connection without replacing the current session proof", async () => {
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    const current = createWorkerSupervisorNodeClient("conn-current");
    runtime.nodeRegistry.register(current, {
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
    });
    const stale = createWorkerSupervisorNodeClient("conn-stale");
    const opts = runnerInventoryOptions({
      nodeRegistry: runtime.nodeRegistry,
      client: stale,
      declaration: availableHost,
    });

    await runnerInventoryHandler(opts);

    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    await expect(runtime.nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([]);
    runtime.nodeRegistry.unregister("conn-current");
  });
});
