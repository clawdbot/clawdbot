import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import { WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND } from "../infra/node-commands.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../infra/node-runner-inventory.js";
import {
  testNodeWorkerLaunchIdentity,
  testWorkerLaunchInput,
} from "../node-host/node-worker-supervisor.test-support.js";
import { parseNodeWorkerLaunchInput } from "../worker/node-supervisor-protocol.js";
import { buildNodeInvokeRequest, serializeNodeEvent } from "./node-invoke-request.js";
import { createNodeRegistryRuntime, updateNodeRunnerInventory } from "./node-registry-private.js";
import { NodeRegistry } from "./node-registry.js";
import {
  createNodeWorkerLaunchAdapter,
  measureNodeWorkerLaunchBytes,
} from "./worker-environments/node-launch-adapter.js";

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

  it("keeps the first dispatched launch alive beyond the availability grace", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const controller = new AbortController();
    const input = testWorkerLaunchInput("/tmp/workspace", "delayed-receipt-turn");
    const terminal = {
      ...testNodeWorkerLaunchIdentity(input),
      state: "completed",
      resultJson: JSON.stringify({
        status: "completed",
        transcriptLeafId: "leaf-1",
        transcriptNextSeq: 2,
      }),
    };
    const sent = vi.spyOn(socket, "send");
    const received = once(client, "message");
    const dispatched = vi.fn();
    const adapter = createNodeWorkerLaunchAdapter({
      getTransport: () => nodeWorkerSupervisorTransport,
    });
    const outcome = adapter
      .launch({
        deviceId: nodeId,
        input,
        isDispatchAuthorized: () => true,
        isCancellationAuthorized: () => true,
        timeoutMs: 60_000,
        signal: controller.signal,
        onDispatchReady: dispatched,
      })
      .catch((error: unknown) => error);
    try {
      const [data] = await received;
      const request = JSON.parse(Buffer.from(data).toString("utf8"));
      expect(request.event).toBe("node.invoke.request");
      expect(request.payload.command).toBe(NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND);
      expect(dispatched).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(11_000);

      // A timeout at the old availability boundary sends cancellation or a duplicate launch.
      expect(sent).toHaveBeenCalledOnce();
      expect(
        nodeRegistry.handleInvokeResult({
          id: request.payload.id,
          nodeId,
          connId,
          ok: true,
          payloadJSON: JSON.stringify(terminal),
        }),
      ).toBe(true);
      expect(await outcome).toEqual(terminal);
      expect(sent).toHaveBeenCalledOnce();
    } finally {
      controller.abort();
      await vi.runAllTimersAsync();
      await outcome;
      sent.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    { timeoutMs: 30_000, expected: { code: "runner-offline" } },
    { timeoutMs: 5_000, expected: { message: "node worker launch timed out" } },
    { timeoutMs: 10_000, expected: { message: "node worker launch timed out" } },
  ])(
    "rejects clock expiry during discovery before dispatch with a $timeoutMs ms launch budget",
    async ({ timeoutMs, expected }) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const controller = new AbortController();
      const startedAt = Date.now();
      const listCurrentNodes = nodeWorkerSupervisorTransport.listCurrentNodes.bind(
        nodeWorkerSupervisorTransport,
      );
      const discovery = vi
        .spyOn(nodeWorkerSupervisorTransport, "listCurrentNodes")
        .mockImplementationOnce(async () => {
          const nodes = await listCurrentNodes();
          vi.setSystemTime(startedAt + 10_000);
          return nodes;
        });
      const sent = vi.spyOn(socket, "send");
      const unhandledRejection = vi.fn();
      process.on("unhandledRejection", unhandledRejection);
      const adapter = createNodeWorkerLaunchAdapter({
        getTransport: () => nodeWorkerSupervisorTransport,
      });
      const outcome = adapter
        .launch({
          deviceId: nodeId,
          input: testWorkerLaunchInput("/tmp/workspace", "discovery-expiry-turn"),
          isDispatchAuthorized: () => true,
          isCancellationAuthorized: () => true,
          timeoutMs,
          signal: controller.signal,
        })
        .catch((error: unknown) => error);
      try {
        await vi.advanceTimersByTimeAsync(0);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(sent).not.toHaveBeenCalled();
        expect(await outcome).toMatchObject(expected);
        expect(unhandledRejection).not.toHaveBeenCalled();
      } finally {
        controller.abort();
        await vi.runAllTimersAsync();
        await outcome;
        process.off("unhandledRejection", unhandledRejection);
        discovery.mockRestore();
        sent.mockRestore();
        vi.useRealTimers();
      }
    },
  );
});
