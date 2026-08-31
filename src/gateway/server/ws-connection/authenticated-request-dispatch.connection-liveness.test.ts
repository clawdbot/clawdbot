import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createGatewayConnectionState } from "../../server-connection-state.js";
import type { GatewayRequestOptions } from "../../server-methods/types.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./authenticated-request-dispatch.test-support.js";

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
      await handler({
        ...options,
        params: (options.req.params ?? {}) as Record<string, unknown>,
      });
    },
  };
});

describe.sequential("authenticated request connection liveness", () => {
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
      assertEmpty: (state: ReturnType<typeof createGatewayConnectionState>) =>
        expect(state.sessionMessageSubscribers.get("agent:main:main")).toEqual(new Set()),
    },
  ])("rejects a late $method mutation after disconnect cleanup", async (testCase) => {
    const held = createDeferredCore();
    const started = createDeferredCore();
    runtime.beforeHandler.mockImplementation(() => {
      started.resolve();
      return held.promise;
    });
    const state = createGatewayConnectionState({ cfg: {} });
    const client = createOperatorWsClient({
      connId: "late-subscription-connection",
      scopes: ["operator.read"],
    });
    state.clients.add(client);
    const harness = createDispatchTestHarness({
      connId: client.connId,
      buildRequestContext: () => ({
        getRuntimeConfig: () => ({}),
        logGateway: { error: vi.fn() },
        subscribeSessionEvents: state.sessionEventSubscribers.subscribe,
        subscribeSessionMessageEvents: state.sessionMessageSubscribers.subscribe,
      }),
    });

    await harness.dispatcher.dispatch(
      { type: "req", id: testCase.method, method: testCase.method, params: testCase.params },
      client,
    );
    await started.promise;
    expect(runtime.beforeHandler).toHaveBeenCalledOnce();

    state.clients.delete(client);
    state.sessionEventSubscribers.unsubscribe(client.connId);
    state.sessionMessageSubscribers.unsubscribeAll(client.connId);
    held.resolve();

    expect(await harness.awaitResponseFrame(testCase.method)).toMatchObject({ ok: true });
    testCase.assertEmpty(state);
  });
});
