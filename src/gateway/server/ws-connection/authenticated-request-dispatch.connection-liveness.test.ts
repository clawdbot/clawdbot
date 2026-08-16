import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createGatewayConnectionState } from "../../server-connection-state.js";
import type { GatewayRequestOptions } from "../../server-methods/types.js";
import type { GatewayWsClient } from "../ws-types.js";
import { createGatewayAuthenticatedRequestDispatcher } from "./authenticated-request-dispatch.js";
import type { GatewayWsMessageHandlerParams } from "./message-handler-types.js";

const runtime = vi.hoisted(() => ({ beforeHandler: vi.fn<() => Promise<void>>() }));

vi.mock("./authenticated-request-dispatch.server-methods.runtime.js", async () => {
  const { sessionSubscriptionHandlers } =
    await import("../../server-methods/sessions-subscriptions.js");
  return {
    handleGatewayRequest: async (options: GatewayRequestOptions) => {
      await runtime.beforeHandler();
      const handler = sessionSubscriptionHandlers[options.req.method];
      if (!handler) {
        throw new Error(`missing test handler for ${options.req.method}`);
      }
      await handler({ ...options, params: options.req.params });
    },
  };
});

function createClient(): GatewayWsClient {
  return {
    socket: {} as WebSocket,
    connId: "late-subscription-connection",
    usesSharedGatewayAuth: false,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "gateway-client", version: "dev", platform: "test", mode: "backend" },
      role: "operator",
      scopes: ["operator.read"],
    },
  };
}

describe("authenticated request connection liveness", () => {
  beforeEach(() => {
    runtime.beforeHandler.mockReset();
  });

  it.each([
    {
      method: "sessions.subscribe",
      params: {},
      assertEmpty: (state: ReturnType<typeof createGatewayConnectionState>) =>
        expect(state.sessionEventSubscribers.getAll()).toEqual(new Set()),
    },
    {
      method: "sessions.messages.subscribe",
      params: { key: "agent:main:main" },
      assertEmpty: (state: ReturnType<typeof createGatewayConnectionState>) => {
        expect(state.sessionMessageSubscribers.get("agent:main:main")).toEqual(new Set());
        expect(
          state.sessionMessageSubscribers.getForConnection("late-subscription-connection"),
        ).toEqual(new Set());
      },
    },
  ])("rejects a late $method mutation after disconnect cleanup", async (testCase) => {
    let releaseHandler!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    runtime.beforeHandler.mockReturnValue(held);
    const state = createGatewayConnectionState({ cfg: {} });
    const client = createClient();
    state.clients.add(client);
    const send = vi.fn((_frame: unknown) => ({ kind: "sent" }) as const);
    const context = {
      getRuntimeConfig: () => ({}),
      logGateway: { error: vi.fn() },
      subscribeSessionEvents: state.sessionEventSubscribers.subscribe,
      subscribeSessionMessageEvents: state.sessionMessageSubscribers.subscribe,
    };
    const dispatcher = createGatewayAuthenticatedRequestDispatcher({
      handler: {
        connId: client.connId,
        extraHandlers: {},
        buildRequestContext: () => context as never,
        send,
        close: vi.fn(),
        isClosed: () => false,
        setCloseCause: vi.fn(),
        logGateway: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } as unknown as GatewayWsMessageHandlerParams,
      isWebchatConnect: () => false,
    });

    await dispatcher.dispatch(
      { type: "req", id: testCase.method, method: testCase.method, params: testCase.params },
      client,
    );
    await vi.waitFor(() => expect(runtime.beforeHandler).toHaveBeenCalledOnce());

    state.clients.delete(client);
    state.sessionEventSubscribers.unsubscribe(client.connId);
    state.sessionMessageSubscribers.unsubscribeAll(client.connId);
    releaseHandler();

    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: testCase.method, ok: true })),
    );
    testCase.assertEmpty(state);
  });
});
