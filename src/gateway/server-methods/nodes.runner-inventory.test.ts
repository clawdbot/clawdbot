import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { WORKER_PROTOCOL_FEATURES } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import {
  createNodeRegistryRuntime,
  setNodeRunnerInventoryChangedListener,
} from "../node-registry-private.js";
import { NodeRegistry } from "../node-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { nodeHandlers } from "./nodes.js";
import { createWorkerSupervisorNodeClient } from "./nodes.runner-inventory.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const WORKER_RUNS = {
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.8.1",
  protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
};

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
    context: { nodeRegistry: params.nodeRegistry },
  } as unknown as GatewayRequestHandlerOptions;
}

const runnerInventoryHandler = expectDefined(
  nodeHandlers["node.runnerInventory.update"],
  'nodeHandlers["node.runnerInventory.update"] test invariant',
);

describe("nodeHandlers node.runnerInventory.update", () => {
  it("publishes the atomic runner inventory for the exact authenticated node session", async () => {
    const inventoryChanged = vi.fn();
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    setNodeRunnerInventoryChangedListener(runtime.nodeRegistry, inventoryChanged);
    const client = createWorkerSupervisorNodeClient("conn-1", WORKER_RUNS);
    runtime.nodeRegistry.register(client, {
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
    });
    const opts = runnerInventoryOptions({
      nodeRegistry: runtime.nodeRegistry,
      client,
      declaration: {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerRuns: WORKER_RUNS,
      },
    });

    await runnerInventoryHandler(opts);

    expect(opts.respond).toHaveBeenCalledWith(true, { nodeId: "node-1" }, undefined);
    expect(inventoryChanged).toHaveBeenCalledWith("node-1");
    await expect(runtime.nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([
      expect.objectContaining({
        nodeId: "node-1",
        connId: "conn-1",
        pairingGeneration: "generation-1",
        workerRuns: WORKER_RUNS,
      }),
    ]);
    runtime.nodeRegistry.unregister("conn-1");
  });

  it("atomically withdraws worker hosting without dropping the supervisor dialect", async () => {
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    const client = createWorkerSupervisorNodeClient("conn-1", WORKER_RUNS);
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

    await publish({
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
      workerRuns: WORKER_RUNS,
    });
    await publish({ protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE] });

    await expect(runtime.nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([
      expect.not.objectContaining({ workerRuns: expect.anything() }),
    ]);
    runtime.nodeRegistry.unregister("conn-1");
  });

  it("does not notify for an identical inventory publication", async () => {
    const inventoryChanged = vi.fn();
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    setNodeRunnerInventoryChangedListener(runtime.nodeRegistry, inventoryChanged);
    const client = createWorkerSupervisorNodeClient("conn-1", WORKER_RUNS);
    runtime.nodeRegistry.register(client, {
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
    });
    const declaration = {
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
      workerRuns: WORKER_RUNS,
    };
    const first = runnerInventoryOptions({
      nodeRegistry: runtime.nodeRegistry,
      client,
      declaration,
    });
    const second = runnerInventoryOptions({
      nodeRegistry: runtime.nodeRegistry,
      client,
      declaration,
    });

    await runnerInventoryHandler(first);
    await runnerInventoryHandler(second);

    expect(inventoryChanged).toHaveBeenCalledTimes(1);
    runtime.nodeRegistry.unregister("conn-1");
  });

  it("retains a generation-less declaration until same-connection pairing promotion", async () => {
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    const client = createWorkerSupervisorNodeClient();
    runtime.nodeRegistry.register(client, { pairingIdentity: "identity-1" });
    const opts = runnerInventoryOptions({
      nodeRegistry: runtime.nodeRegistry,
      client,
      declaration: { protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE] },
    });

    await runnerInventoryHandler(opts);
    expect(opts.respond).toHaveBeenCalledWith(true, { nodeId: "node-1" }, undefined);
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
    await expect(runtime.nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([
      expect.objectContaining({ pairingGeneration: "generation-1" }),
    ]);
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
    { name: "wrong dialect", params: { protocolFeatures: ["node-worker-supervisor-v2"] } },
    {
      name: "worker build without dialect",
      params: { protocolFeatures: [], workerRuns: WORKER_RUNS },
    },
    {
      name: "invalid worker build",
      params: {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerRuns: { ...WORKER_RUNS, bundleHash: "not-a-hash" },
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
      declaration: { protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE] },
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
