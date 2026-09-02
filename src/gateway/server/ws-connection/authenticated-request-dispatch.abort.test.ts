/** Verifies transport disconnect cancellation stays scoped to request-owned work. */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { NodeRegistry } from "../../node-registry.js";
import type { GatewayRequestOptions } from "../../server-methods/types.js";
import type { GatewayWsClient } from "../ws-types.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./authenticated-request-dispatch.test-support.js";

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
  let frameArrived = createDeferredCore();
  const waitForFrameCount = async (count: number) => {
    while (frames.length < count) {
      await frameArrived.promise;
    }
  };
  const registry = new NodeRegistry();
  activeRegistries.add(registry);
  registry.register(
    {
      connId: "paired-node-connection",
      usesSharedGatewayAuth: false,
      socket: {
        readyState: WebSocket.OPEN,
        send(frame: unknown) {
          if (typeof frame === "string") {
            frames.push(frame);
            frameArrived.resolve();
            frameArrived = createDeferredCore();
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
  return { registry, frames, waitForFrameCount };
}

function createDispatcher(
  socket: EventEmitter,
  clientInfo: Pick<GatewayWsClient["connect"]["client"], "id" | "mode"> = {
    id: GATEWAY_CLIENT_IDS.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
  },
) {
  const client = createOperatorWsClient({
    connId: "operator-connection",
    socket,
    clientInfo,
    scopes: ["operator.write"],
  });
  const harness = createDispatchTestHarness({ connId: client.connId });
  return { client, ...harness };
}

describe("authenticated WebSocket request cancellation", () => {
  it("forwards CLI socket closure to the actual first-party node cancel event", async () => {
    const socket = new EventEmitter();
    const { registry, frames, waitForFrameCount } = createPairedNode();
    const { awaitResponseFrame, client, dispatcher } = createDispatcher(socket);
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
    await waitForFrameCount(1);
    expect(socket.listenerCount("close")).toBe(1);

    socket.emit("close", 1000, Buffer.alloc(0));

    await waitForFrameCount(2);
    const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };
    expect(JSON.parse(frames[1] ?? "{}")).toMatchObject({
      event: "node.invoke.cancel",
      payload: { invokeId: request.payload?.id, nodeId: "paired-node" },
    });
    await awaitResponseFrame("paired-node-cli-inference");
    // Listener removal is the dispatch finally block, a microtask after the response.
    await vi.waitFor(() => expect(socket.listenerCount("close")).toBe(0));
  });

  it.each(["test.trace", "sessions.cleanup", "agents.delete"])(
    "keeps authenticated %s work alive after its socket disconnects",
    async (method) => {
      const socket = new EventEmitter();
      const { awaitResponseFrame, client, dispatcher } = createDispatcher(socket);
      const invoked = createDeferredCore();
      const completion = createDeferredCore();
      let completed = false;
      handleGatewayRequest.mockImplementation(async (options: GatewayRequestOptions) => {
        invoked.resolve();
        await completion.promise;
        completed = true;
        options.respond(true, { ok: true });
      });

      await dispatcher.dispatch(
        { type: "req", id: "ordinary-request", method, params: {} },
        client,
      );
      await invoked.promise;
      expect(handleGatewayRequest).toHaveBeenCalledOnce();

      expect(handleGatewayRequest.mock.calls[0]?.[0]).not.toHaveProperty("signal");
      expect(socket.listenerCount("close")).toBe(0);
      socket.emit("close", 1006, Buffer.alloc(0));
      expect(completed).toBe(false);

      completion.resolve();
      await awaitResponseFrame("ordinary-request");
      expect(completed).toBe(true);
    },
  );

  it.each(["sessions.companion.ask", "models.authLogin.start"])(
    "cancels %s when its authenticated socket closes",
    async (method) => {
      const socket = new EventEmitter();
      const { client, dispatcher } = createDispatcher(socket, {
        id: GATEWAY_CLIENT_IDS.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.UI,
      });
      const invoked = createDeferredCore();
      const abortObserved = createDeferredCore();
      let observedSignal: AbortSignal | undefined;
      handleGatewayRequest.mockImplementation(async (options: GatewayRequestOptions) => {
        observedSignal = options.signal;
        options.signal?.addEventListener("abort", () => abortObserved.resolve(), { once: true });
        invoked.resolve();
        await abortObserved.promise;
      });

      await dispatcher.dispatch(
        {
          type: "req",
          id: "disconnect-cancelled-request",
          method,
          params: { sessionKey: "agent:main:main", question: "What changed?" },
        },
        client,
      );
      // Emitting close before the handler registers its abort listener would leave
      // the already-aborted signal unobserved; wait for the handler first.
      await invoked.promise;
      expect(socket.listenerCount("close")).toBe(1);

      socket.emit("close", 1000, Buffer.alloc(0));

      await abortObserved.promise;
      expect(observedSignal?.aborted).toBe(true);
      await vi.waitFor(() => expect(socket.listenerCount("close")).toBe(0));
    },
  );

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
      const { registry, frames, waitForFrameCount } = createPairedNode();
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
      await waitForFrameCount(1);
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
