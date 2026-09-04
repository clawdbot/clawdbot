// Shared fixture for tests driving createGatewayAuthenticatedRequestDispatcher.
import { vi } from "vitest";
import type { WebSocket } from "ws";
import { createDeferredCore, type Deferred } from "../../../shared/deferred.js";
import type { GatewayWsClient } from "../ws-types.js";
import { createGatewayAuthenticatedRequestDispatcher } from "./authenticated-request-dispatch.js";
import type { GatewayWsMessageHandlerParams } from "./message-handler-types.js";

export type GatewayTestResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string } & Record<string, unknown>;
};

export function createOperatorWsClient(
  overrides: {
    connId?: string;
    socket?: unknown;
    clientInfo?: { id: string; mode: string };
    scopes?: string[];
  } = {},
): GatewayWsClient {
  return {
    socket: (overrides.socket ?? {}) as WebSocket,
    connId: overrides.connId ?? "dispatch-test-connection",
    usesSharedGatewayAuth: false,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: overrides.clientInfo?.id ?? "gateway-client",
        version: "dev",
        platform: "test",
        mode: overrides.clientInfo?.mode ?? "backend",
      },
      role: "operator",
      scopes: overrides.scopes ?? ["operator.admin"],
    },
  } as GatewayWsClient;
}

export function createDispatchTestHarness(
  options: {
    connId?: string;
    extraHandlers?: GatewayWsMessageHandlerParams["extraHandlers"];
    buildRequestContext?: () => unknown;
    isClosed?: () => boolean;
    getRequiredSharedGatewaySessionGeneration?: () => string | undefined;
  } = {},
) {
  const sentResponses: GatewayTestResponseFrame[] = [];
  const responseWaiters: { id: string; deferred: Deferred<GatewayTestResponseFrame> }[] = [];
  const send = vi.fn<GatewayWsMessageHandlerParams["send"]>(() => ({ kind: "sent" }));
  // Recording lives outside the spy so tests may replace send's implementation
  // (to observe call context) without silently breaking awaitResponseFrame.
  const sendForDispatcher = (frame: unknown) => {
    const response = frame as GatewayTestResponseFrame;
    if (response?.type === "res") {
      sentResponses.push(response);
      for (let index = responseWaiters.length - 1; index >= 0; index -= 1) {
        const waiter = responseWaiters[index];
        if (waiter && waiter.id === response.id) {
          responseWaiters.splice(index, 1);
          waiter.deferred.resolve(response);
        }
      }
    }
    return send(frame) ?? ({ kind: "sent" } as const);
  };
  const close = vi.fn();
  const setCloseCause = vi.fn();
  const logGateway = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const dispatcher = createGatewayAuthenticatedRequestDispatcher({
    handler: {
      connId: options.connId ?? "dispatch-test-connection",
      extraHandlers: options.extraHandlers ?? {},
      buildRequestContext: () => (options.buildRequestContext?.() ?? {}) as never,
      send: sendForDispatcher,
      close,
      isClosed: options.isClosed ?? (() => false),
      getRequiredSharedGatewaySessionGeneration: options.getRequiredSharedGatewaySessionGeneration,
      setCloseCause,
      logGateway,
    } as unknown as GatewayWsMessageHandlerParams,
    isWebchatConnect: () => false,
  });
  // dispatch() is fire-and-forget behind a lazy server-methods import, so waiting
  // on the response event keeps tests off polling deadlines that lose to a slow
  // first module load and leak in-flight dispatches into sibling cases.
  const awaitResponseFrame = (id: string): Promise<GatewayTestResponseFrame> => {
    const already = sentResponses.find((frame) => frame.id === id);
    if (already) {
      return Promise.resolve(already);
    }
    const deferred = createDeferredCore<GatewayTestResponseFrame>();
    responseWaiters.push({ id, deferred });
    return deferred.promise;
  };
  return {
    awaitResponseFrame,
    close,
    dispatcher: {
      dispatch: (frame: unknown, client: GatewayWsClient) =>
        dispatcher.dispatch(frame, client, Buffer.byteLength(JSON.stringify(frame))),
    },
    logGateway,
    send,
    setCloseCause,
  };
}
