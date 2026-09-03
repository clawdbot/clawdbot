import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import { WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND } from "../infra/node-commands.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../infra/node-runner-inventory.js";
import { testWorkerLaunchInput } from "../node-host/node-worker-supervisor.test-support.js";
import { parseNodeWorkerLaunchInput } from "../worker/node-supervisor-protocol.js";
import { buildNodeInvokeRequest, serializeNodeEvent } from "./node-invoke-request.js";
import { createNodeRegistryRuntime, updateNodeRunnerInventory } from "./node-registry-private.js";
import { NodeRegistry } from "./node-registry.js";
import { measureNodeWorkerLaunchBytes } from "./worker-environments/node-launch-adapter.js";

describe("private worker launch wire", () => {
  // Exercise the real node/client message limit without starting a Gateway or a worker.
  const nodeId = `fixture-node-${'é"\\'.repeat(300)}`;
  const connId = "fixture-connection";
  const { nodeRegistry, nodeWorkerSupervisorTransport } = createNodeRegistryRuntime(
    () => new NodeRegistry(),
  );
  let server: WebSocketServer;
  let client: WebSocket;
  let socket: WebSocket;

  beforeAll(async () => {
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback listener");
    }
    const connected = once(server, "connection");
    client = new WebSocket(`ws://127.0.0.1:${address.port}`, {
      maxPayload: WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
    });
    await once(client, "open");
    [socket] = await connected;
    nodeRegistry.register(
      {
        connId,
        socket,
        usesSharedGatewayAuth: false,
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: GATEWAY_CLIENT_IDS.NODE_HOST,
            version: "test",
            platform: "test",
            mode: "node",
          },
          device: {
            id: nodeId,
            publicKey: "fixture",
            signature: "fixture",
            signedAt: 1,
            nonce: "fixture",
          },
          commands: [NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND],
        },
      },
      { pairingIdentity: "fixture-pairing", pairingGeneration: "fixture-generation" },
    );
    updateNodeRunnerInventory({
      registry: nodeRegistry,
      nodeId,
      connId,
      declaration: {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: { enabled: true, capacity: { total: 1, available: 1 }, environmentSession: 1 },
      },
    });
  });

  afterAll(async () => {
    nodeRegistry.unregister(connId);
    client?.terminate();
    socket?.terminate();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it.each([-1, 0, 1])("enforces the complete node frame at cap %+i byte(s)", async (delta) => {
    const input = testWorkerLaunchInput("/tmp/workspace", "fixture-turn");
    input.descriptor.assignment.systemPrompt = '"\\\0\n漢😀'.repeat(10_000);
    const encode = () =>
      serializeNodeEvent(
        "node.invoke.request",
        buildNodeInvokeRequest({
          id: "00000000-0000-0000-0000-000000000000",
          nodeId,
          command: NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
          params: input,
          timeoutMs: 0,
          idempotencyKey: input.launchId,
        }),
      );
    const targetBytes = WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES + delta;
    input.descriptor.assignment.systemPrompt += "x".repeat(
      targetBytes - Buffer.byteLength(encode()),
    );
    parseNodeWorkerLaunchInput(JSON.stringify(input));
    expect(Buffer.byteLength(encode())).toBe(targetBytes);
    expect(measureNodeWorkerLaunchBytes(nodeId, input)).toBeGreaterThanOrEqual(targetBytes);
    const [node] = await nodeWorkerSupervisorTransport.listCurrentNodes();
    if (!node) {
      throw new Error("expected private runner proof");
    }
    const received = delta <= 0 ? once(client, "message") : undefined;
    const sent = vi.spyOn(socket, "send");
    const dispatched = vi.fn((id: string) => {
      nodeRegistry.handleInvokeResult({ id, nodeId, connId, ok: true, payloadJSON: "null" });
    });
    try {
      const result = await nodeWorkerSupervisorTransport.invoke({
        node,
        command: NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
        params: input,
        timeoutMs: 0,
        idempotencyKey: input.launchId,
        isDispatchAuthorized: () => true,
        onDispatchReady: dispatched,
      });
      if (received) {
        expect(result.ok).toBe(true);
        const [data] = await received;
        const frame = Buffer.from(data);
        expect(frame.byteLength).toBe(targetBytes);
        const decoded = JSON.parse(frame.toString("utf8"));
        const launch = parseNodeWorkerLaunchInput(decoded.payload.paramsJSON);
        expect(launch.descriptor.assignment.systemPrompt?.length).toBe(
          input.descriptor.assignment.systemPrompt.length,
        );
        expect(launch.descriptor.assignment.operationalRunInstance).toEqual(
          input.descriptor.assignment.operationalRunInstance,
        );
        expect(dispatched).toHaveBeenCalledOnce();
      } else {
        expect(result).toEqual({
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: "worker launch exceeds the node payload limit",
          },
        });
        expect(sent).not.toHaveBeenCalled();
        expect(dispatched).not.toHaveBeenCalled();
      }
      console.info(
        "worker-node-frame",
        JSON.stringify({ bytes: targetBytes, dispatched: result.ok }),
      );
    } finally {
      sent.mockRestore();
    }
  });
});
