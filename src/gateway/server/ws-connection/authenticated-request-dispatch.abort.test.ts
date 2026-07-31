/** Verifies transport disconnect cancels only its own paired-node invocation. */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { NodeRegistry } from "../../node-registry.js";
import type { GatewayRequestOptions } from "../../server-methods/types.js";
import type { GatewayWsClient } from "../ws-types.js";
import { createGatewayAuthenticatedRequestDispatcher } from "./authenticated-request-dispatch.js";
import type { GatewayWsMessageHandlerParams } from "./message-handler-types.js";

const handleGatewayRequest = vi.hoisted(() => vi.fn());

vi.mock("./authenticated-request-dispatch.server-methods.runtime.js", () => ({
  handleGatewayRequest,
}));

const activeRegistries = new Set<NodeRegistry>();

afterEach(() => {
  for (const registry of activeRegistries) {
    registry.unregister("paired-node-connection");
  }
  activeRegistries.clear();
  handleGatewayRequest.mockReset();
});

function createPairedNode() {
  const frames: string[] = [];
  const registry = new NodeRegistry();
  activeRegistries.add(registry);
  registry.register(
    {
      connId: "paired-node-connection",
      usesSharedGatewayAuth: false,
      socket: {
        send(frame: unknown) {
          if (typeof frame === "string") {
            frames.push(frame);
          }
        },
      },
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: {
          id: GATEWAY_CLIENT_IDS.NODE_HOST,
          version: "1.0.0",
          platform: "linux",
          mode: "node",
        },
        device: {
          id: "paired-node",
          publicKey: "public-key",
          signature: "signature",
          signedAt: 1,
          nonce: "nonce",
        },
        caps: ["local-inference"],
        commands: ["ollama.chat"],
      },
    } as GatewayWsClient,
    { pairingIdentity: "paired-node-identity" },
  );
  return { registry, frames };
}

function createDispatcher(
  socket: EventEmitter,
  clientIdentity: Pick<GatewayWsClient["connect"]["client"], "id" | "mode"> = {
    id: GATEWAY_CLIENT_IDS.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
  },
) {
  const client = {
    socket: socket as unknown as WebSocket,
    connId: "operator-connection",
    usesSharedGatewayAuth: false,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { ...clientIdentity, version: "1.0.0", platform: "linux" },
      role: "operator",
      scopes: ["operator.write"],
    },
  } as GatewayWsClient;
  const dispatcher = createGatewayAuthenticatedRequestDispatcher({
    handler: {
      connId: client.connId,
      extraHandlers: {},
      buildRequestContext: () => ({}) as never,
      send: vi.fn(),
      close: vi.fn(),
      isClosed: () => false,
      setCloseCause: vi.fn(),
      logGateway: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as GatewayWsMessageHandlerParams,
    isWebchatConnect: () => false,
  });
  return { client, dispatcher };
}

describe("paired-node WebSocket request cancellation", () => {
  it("forwards CLI socket closure to the actual first-party node cancel event", async () => {
    const socket = new EventEmitter();
    const { registry, frames } = createPairedNode();
    const { client, dispatcher } = createDispatcher(socket);
    handleGatewayRequest.mockImplementation(async (options: GatewayRequestOptions) => {
      const result = await registry.invoke({
        nodeId: "paired-node",
        command: "ollama.chat",
        timeoutMs: 10_000,
        signal: options.signal,
      });
      options.respond(
        result.ok,
        result.payload,
        result.error
          ? {
              code: result.error.code ?? "UNAVAILABLE",
              message: result.error.message ?? "node invocation failed",
            }
          : undefined,
      );
    });

    await dispatcher.dispatch(
      {
        type: "req",
        id: "paired-node-cli-inference",
        method: "node.invoke",
        params: {
          nodeId: "paired-node",
          command: "ollama.chat",
          idempotencyKey: "paired-node-cli-inference",
        },
      },
      client,
    );
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(socket.listenerCount("close")).toBe(1);

    socket.emit("close", 1000, Buffer.alloc(0));

    await vi.waitFor(() => expect(frames).toHaveLength(2));
    const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };
    expect(JSON.parse(frames[1] ?? "{}")).toMatchObject({
      event: "node.invoke.cancel",
      payload: { invokeId: request.payload?.id, nodeId: "paired-node" },
    });
    await vi.waitFor(() => expect(socket.listenerCount("close")).toBe(0));
  });

  it("does not attach a node cancellation lifetime to unrelated requests", async () => {
    const socket = new EventEmitter();
    const { client, dispatcher } = createDispatcher(socket);
    handleGatewayRequest.mockImplementation(async (options: GatewayRequestOptions) => {
      options.respond(true, { ok: true });
    });

    await dispatcher.dispatch(
      { type: "req", id: "ordinary-request", method: "test.trace", params: {} },
      client,
    );
    await vi.waitFor(() => expect(handleGatewayRequest).toHaveBeenCalledOnce());

    expect(handleGatewayRequest.mock.calls[0]?.[0]).not.toHaveProperty("signal");
    expect(socket.listenerCount("close")).toBe(0);
  });

  it.each([
    {
      label: "control UI",
      id: GATEWAY_CLIENT_IDS.CONTROL_UI,
      mode: GATEWAY_CLIENT_MODES.UI,
    },
    {
      label: "gateway SDK",
      id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    },
    {
      label: "native macOS app",
      id: GATEWAY_CLIENT_IDS.MACOS_APP,
      mode: GATEWAY_CLIENT_MODES.UI,
    },
  ])(
    "does not cancel an authenticated $label node invocation on socket close",
    async (identity) => {
      const socket = new EventEmitter();
      const { registry, frames } = createPairedNode();
      const { client, dispatcher } = createDispatcher(socket, identity);
      handleGatewayRequest.mockImplementation(async (options: GatewayRequestOptions) => {
        const result = await registry.invoke({
          nodeId: "paired-node",
          command: "ollama.chat",
          timeoutMs: 10_000,
          signal: options.signal,
        });
        options.respond(result.ok, result.payload);
      });

      await dispatcher.dispatch(
        {
          type: "req",
          id: "paired-node-ordinary-inference",
          method: "node.invoke",
          params: {
            nodeId: "paired-node",
            command: "ollama.chat",
            idempotencyKey: "paired-node-ordinary-inference",
          },
        },
        client,
      );
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      expect(handleGatewayRequest.mock.calls[0]?.[0]).not.toHaveProperty("signal");
      expect(socket.listenerCount("close")).toBe(0);

      socket.emit("close", 1000, Buffer.alloc(0));

      expect(frames).toHaveLength(1);
      const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };
      expect(
        registry.handleInvokeResult({
          id: request.payload?.id ?? "",
          nodeId: "paired-node",
          connId: "paired-node-connection",
          ok: true,
        }),
      ).toBe(true);
    },
  );
});
