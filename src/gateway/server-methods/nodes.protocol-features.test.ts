import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-worker-supervisor-dialect.js";
import { createNodeRegistryRuntime } from "../node-registry-private.js";
import { NodeRegistry } from "../node-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { nodeHandlers } from "./nodes.js";
import { createWorkerSupervisorNodeClient } from "./nodes.protocol-features.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function protocolFeatureOptions(params: {
  nodeRegistry: NodeRegistry;
  client: GatewayWsClient;
  protocolFeatures: unknown;
}): GatewayRequestHandlerOptions {
  return {
    req: {
      type: "req",
      id: "req-1",
      method: "node.protocolFeatures.update",
      params: params.protocolFeatures,
    },
    params: params.protocolFeatures,
    client: params.client as never,
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: { nodeRegistry: params.nodeRegistry },
  } as unknown as GatewayRequestHandlerOptions;
}

const protocolFeatureHandler = expectDefined(
  nodeHandlers["node.protocolFeatures.update"],
  'nodeHandlers["node.protocolFeatures.update"] test invariant',
);

describe("nodeHandlers node.protocolFeatures.update", () => {
  it("publishes the closed worker dialect for the exact authenticated node session", async () => {
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    const client = createWorkerSupervisorNodeClient();
    runtime.nodeRegistry.register(client, {
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
    });
    const opts = protocolFeatureOptions({
      nodeRegistry: runtime.nodeRegistry,
      client,
      protocolFeatures: { protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE] },
    });

    await protocolFeatureHandler(opts);

    expect(opts.respond).toHaveBeenCalledWith(true, { nodeId: "node-1" }, undefined);
    await expect(runtime.nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([
      expect.objectContaining({
        nodeId: "node-1",
        connId: "conn-1",
        pairingGeneration: "generation-1",
      }),
    ]);
    runtime.nodeRegistry.unregister("conn-1");
  });

  it("retains a generation-less declaration until same-connection pairing promotion", async () => {
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    const client = createWorkerSupervisorNodeClient();
    runtime.nodeRegistry.register(client, { pairingIdentity: "identity-1" });
    const opts = protocolFeatureOptions({
      nodeRegistry: runtime.nodeRegistry,
      client,
      protocolFeatures: { protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE] },
    });

    await protocolFeatureHandler(opts);
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
  ])("rejects $name without changing private eligibility", async ({ params }) => {
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    const client = createWorkerSupervisorNodeClient();
    runtime.nodeRegistry.register(client, {
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
    });
    const opts = protocolFeatureOptions({
      nodeRegistry: runtime.nodeRegistry,
      client,
      protocolFeatures: params,
    });

    await protocolFeatureHandler(opts);

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
    const opts = protocolFeatureOptions({
      nodeRegistry: runtime.nodeRegistry,
      client: stale,
      protocolFeatures: { protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE] },
    });

    await protocolFeatureHandler(opts);

    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    await expect(runtime.nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([]);
    runtime.nodeRegistry.unregister("conn-current");
  });
});
