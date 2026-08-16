import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { WORKER_PROTOCOL_FEATURES } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { NODE_WORKER_SUPERVISOR_STATUS_COMMAND } from "../../infra/node-commands.js";
import {
  NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
  NODE_WORKER_SUPERVISOR_BUILD_PROTOCOL_FEATURE,
  NODE_WORKER_SUPERVISOR_LEGACY_PROTOCOL_FEATURE,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
} from "../../infra/node-runner-inventory.js";
import {
  createNodeRegistryRuntime,
  setNodeRunnerInventoryChangedListener,
} from "../node-registry-private.js";
import { NodeRegistry } from "../node-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { nodeHandlers } from "./nodes.js";
import { createWorkerSupervisorNodeClient } from "./nodes.runner-inventory.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const LEGACY_WORKER_RUNS = {
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

const availableHost = {
  protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
  workerHost: { enabled: true, capacity: "available", bundlePrewarm: 1 },
} as const;

const fullHost = {
  protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
  workerHost: { enabled: true, capacity: "full", bundlePrewarm: 1 },
} as const;

describe("nodeHandlers node.runnerInventory.update", () => {
  it("publishes explicit runner consent and launch capacity for the authenticated node", async () => {
    const inventoryChanged = vi.fn();
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    setNodeRunnerInventoryChangedListener(runtime.nodeRegistry, inventoryChanged);
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
    expect(inventoryChanged).toHaveBeenCalledWith("node-1");
    await expect(runtime.nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([
      expect.objectContaining({
        nodeId: "node-1",
        connId: "conn-1",
        pairingGeneration: "generation-1",
        workerHost: { enabled: true, capacity: "available", bundlePrewarm: 1 },
      }),
    ]);
    runtime.nodeRegistry.unregister("conn-1");
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
      capacity: "full",
      bundlePrewarm: 1,
    });
    expect(proof && runtime.nodeWorkerSupervisorTransport.isCurrent(proof)).toBe(true);
    expect(proof && runtime.nodeWorkerSupervisorTransport.isCurrent(proof, true)).toBe(false);
    runtime.nodeRegistry.unregister("conn-1");
  });

  it("does not notify for an identical inventory publication", async () => {
    const inventoryChanged = vi.fn();
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    setNodeRunnerInventoryChangedListener(runtime.nodeRegistry, inventoryChanged);
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

  it("retains a generation-less declaration until same-connection pairing promotion", async () => {
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    const client = createWorkerSupervisorNodeClient();
    runtime.nodeRegistry.register(client, { pairingIdentity: "identity-1" });
    const opts = runnerInventoryOptions({
      nodeRegistry: runtime.nodeRegistry,
      client,
      declaration: fullHost,
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
      expect.objectContaining({
        pairingGeneration: "generation-1",
        workerHost: { enabled: true, capacity: "full", bundlePrewarm: 1 },
      }),
    ]);
    runtime.nodeRegistry.unregister("conn-1");
  });

  it("keeps exact v1 inventory diagnostic-only until disconnect and v3 reconnect", async () => {
    const inventoryChanged = vi.fn();
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    setNodeRunnerInventoryChangedListener(runtime.nodeRegistry, inventoryChanged);
    const legacyClient = createWorkerSupervisorNodeClient("conn-v1");
    runtime.nodeRegistry.register(legacyClient, {
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
    });
    const legacy = runnerInventoryOptions({
      nodeRegistry: runtime.nodeRegistry,
      client: legacyClient,
      declaration: {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_LEGACY_PROTOCOL_FEATURE],
        workerRuns: LEGACY_WORKER_RUNS,
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
    expect(inventoryChanged).toHaveBeenLastCalledWith("node-1");
    expect(runtime.nodeWorkerSupervisorTransport.getIssue?.("node-1")).toEqual(
      NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
    );
    await expect(runtime.nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([]);
    const forgedProof = {
      nodeId: "node-1",
      connId: "conn-v1",
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
      clientId: "node-host",
      clientMode: "node",
      protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
      workerHost: { enabled: true, capacity: "available", bundlePrewarm: 1 },
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

    const currentClient = createWorkerSupervisorNodeClient("conn-v2");
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
        connId: "conn-v2",
        workerHost: { enabled: true, capacity: "available", bundlePrewarm: 1 },
      }),
    ]);
    runtime.nodeRegistry.unregister("conn-v2");
  });

  it("routes the shipped v2 build-shaped inventory to update recovery", async () => {
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    const client = createWorkerSupervisorNodeClient();
    runtime.nodeRegistry.register(client, {
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
    });
    const opts = runnerInventoryOptions({
      nodeRegistry: runtime.nodeRegistry,
      client,
      declaration: {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_BUILD_PROTOCOL_FEATURE],
        workerRuns: { ...LEGACY_WORKER_RUNS, bundlePrewarm: 1 },
      },
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
    {
      name: "missing current worker host",
      params: { protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE] },
    },
    {
      name: "legacy build on current dialect",
      params: {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerRuns: LEGACY_WORKER_RUNS,
      },
    },
    {
      name: "disabled host with capacity",
      params: {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: { enabled: false, capacity: "full" },
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
      name: "unsupported bundle prewarm version",
      params: {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: { enabled: true, capacity: "available", bundlePrewarm: 2 },
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
