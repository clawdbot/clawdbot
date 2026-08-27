import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  dispatch: vi.fn(),
  sendAudio: vi.fn(),
  cancelOutput: vi.fn(),
  stopSession: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../plugins/runtime/gateway-request-scope.js", () => ({
  getPluginRuntimeGatewayRequestScope: mocks.scope,
}));
vi.mock("./server-plugin-in-process-dispatch.js", () => ({
  dispatchGatewayMethodInProcess: mocks.dispatch,
}));
vi.mock("./talk-realtime-relay.js", () => ({
  sendTalkRealtimeRelayAudio: mocks.sendAudio,
  cancelTalkRealtimeRelayTurn: mocks.cancelOutput,
  stopTalkRealtimeRelaySession: mocks.stopSession,
}));

import { openPluginTalkSession } from "./talk-plugin-session.js";
import { getPluginTalkSessionDispatchContext } from "./talk-realtime-session-create.js";

type DispatchContext = NonNullable<ReturnType<typeof getPluginTalkSessionDispatchContext>>;

function requireDispatchContext(): DispatchContext {
  const context = getPluginTalkSessionDispatchContext("plugin-http:127.0.0.1");
  if (!context) {
    throw new Error("expected plugin Talk dispatch context");
  }
  return context;
}

describe("plugin Talk session", () => {
  let controller: AbortController;
  let routeController: AbortController;
  let dispatchContexts: DispatchContext[];

  function capturedDispatchContext(index = 0): DispatchContext {
    const context = dispatchContexts[index];
    if (!context) {
      throw new Error(`expected captured plugin Talk dispatch context at index ${index}`);
    }
    return context;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new AbortController();
    routeController = new AbortController();
    dispatchContexts = [];
    mocks.scope.mockReturnValue({
      pluginId: "avatar",
      gatewayMethodDispatchAllowed: true,
      routeSignal: routeController.signal,
      client: {
        connId: "plugin-http:127.0.0.1",
        connect: { scopes: ["operator.talk"] },
      },
      context: { logGateway: { warn: mocks.warn } },
    });
    mocks.dispatch.mockImplementation(async () => {
      dispatchContexts.push(requireDispatchContext());
      return { relaySessionId: "relay-1" };
    });
  });

  it("uses the shared Gateway session and maps owner-scoped media events", async () => {
    const onEvent = vi.fn();
    const session = await openPluginTalkSession({
      sessionKey: "agent:main:avatar",
      signal: controller.signal,
      voice: "alloy",
      onEvent,
    });
    const createParams = capturedDispatchContext();

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "talk.session.create",
      {
        sessionKey: "agent:main:avatar",
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        voice: "alloy",
      },
      { requireScopedClient: true },
    );
    expect(createParams.ownerId).toMatch(/^plugin:avatar:/);
    expect(createParams.quotaOwnerId).toBe("plugin:avatar:plugin-http:127.0.0.1");

    createParams.eventSink({ relaySessionId: "relay-1", type: "ready" });
    createParams.eventSink({
      relaySessionId: "relay-1",
      type: "audio",
      audioBase64: Buffer.from([1, 0]).toString("base64"),
    });
    createParams.eventSink({ relaySessionId: "relay-1", type: "audioDone" });
    session.cancelOutput("barge-in");
    createParams.eventSink({ relaySessionId: "relay-1", type: "clear", reason: "barge-in" });

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(5));
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: "state", generation: 0, ptsMs: 0, state: "listening" },
      { type: "state", generation: 0, ptsMs: 0, state: "speaking" },
      {
        type: "audio",
        generation: 0,
        sequence: 0,
        ptsMs: 0,
        pcm: Buffer.from([1, 0]),
      },
      { type: "state", generation: 0, ptsMs: 1 / 24, state: "listening" },
      { type: "clear", generation: 1, reason: "barge-in" },
    ]);

    session.sendAudio(new Uint8Array([2, 0]), { timestamp: 20 });
    session.close();

    expect(mocks.sendAudio).toHaveBeenCalledWith({
      relaySessionId: "relay-1",
      connId: createParams.ownerId,
      audioBase64: "AgA=",
      timestamp: 20,
    });
    expect(mocks.cancelOutput).toHaveBeenCalledWith({
      relaySessionId: "relay-1",
      connId: createParams.ownerId,
      reason: "barge-in",
    });
    expect(mocks.stopSession).toHaveBeenCalledWith({
      relaySessionId: "relay-1",
      connId: createParams.ownerId,
    });
  });

  it("gives every session a unique owner while sharing its authenticated route quota", async () => {
    await openPluginTalkSession({
      sessionKey: "agent:main:first",
      signal: controller.signal,
      onEvent: vi.fn(),
    });
    await openPluginTalkSession({
      sessionKey: "agent:main:second",
      signal: controller.signal,
      onEvent: vi.fn(),
    });

    expect(new Set(dispatchContexts.map((params) => params.ownerId)).size).toBe(2);
    expect(dispatchContexts.every((params) => params.ownerId.startsWith("plugin:avatar:"))).toBe(
      true,
    );
    expect(dispatchContexts.map((params) => params.quotaOwnerId)).toEqual([
      "plugin:avatar:plugin-http:127.0.0.1",
      "plugin:avatar:plugin-http:127.0.0.1",
    ]);
  });

  it("stops accepting media after the Gateway closes the session", async () => {
    const onEvent = vi.fn();
    const session = await openPluginTalkSession({
      sessionKey: "agent:main:avatar",
      signal: controller.signal,
      onEvent,
    });
    const eventSink = capturedDispatchContext().eventSink;

    eventSink({ relaySessionId: "relay-1", type: "close", reason: "error" });
    eventSink({ relaySessionId: "relay-1", type: "close", reason: "error" });

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledOnce());
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith({
      type: "closed",
      generation: 0,
      reason: "error",
    });
    expect(() => session.sendAudio(new Uint8Array([1, 0]))).toThrow("Talk session is closed");
    session.cancelOutput();
    session.close();
    expect(mocks.cancelOutput).not.toHaveBeenCalled();
    expect(mocks.stopSession).not.toHaveBeenCalled();
  });

  it("closes the relay when the plugin event callback fails", async () => {
    await openPluginTalkSession({
      sessionKey: "agent:main:avatar",
      signal: controller.signal,
      onEvent: async () => {
        throw new Error("renderer gone");
      },
    });
    const createParams = capturedDispatchContext();

    createParams.eventSink({ relaySessionId: "relay-1", type: "ready" });
    await vi.waitFor(() => expect(mocks.stopSession).toHaveBeenCalledOnce());

    expect(mocks.warn).toHaveBeenCalledWith("plugin Talk event delivery failed: renderer gone");
    expect(mocks.stopSession).toHaveBeenCalledWith({
      relaySessionId: "relay-1",
      connId: createParams.ownerId,
    });
  });

  it("closes a session whose event callback fails during creation", async () => {
    mocks.dispatch.mockImplementationOnce(async () => {
      const context = requireDispatchContext();
      dispatchContexts.push(context);
      context.eventSink({ relaySessionId: "relay-1", type: "ready" });
      return { relaySessionId: "relay-1" };
    });

    await expect(
      openPluginTalkSession({
        sessionKey: "agent:main:avatar",
        signal: controller.signal,
        onEvent: () => {
          throw new Error("renderer gone");
        },
      }),
    ).rejects.toThrow("renderer gone");

    expect(mocks.stopSession).toHaveBeenCalledWith({
      relaySessionId: "relay-1",
      connId: capturedDispatchContext().ownerId,
    });
  });

  it("delivers promise-returning event callbacks in order", async () => {
    const firstDelivery = createDeferred();
    const deliveries: string[] = [];
    await openPluginTalkSession({
      sessionKey: "agent:main:avatar",
      signal: controller.signal,
      onEvent: async (event) => {
        if (event.type !== "state") {
          return;
        }
        deliveries.push(`start:${event.state}`);
        if (event.state === "listening") {
          await firstDelivery.promise;
        }
        deliveries.push(`end:${event.state}`);
      },
    });
    const eventSink = capturedDispatchContext().eventSink;

    eventSink({ relaySessionId: "relay-1", type: "ready" });
    eventSink({ relaySessionId: "relay-1", type: "audio", audioBase64: "" });

    expect(deliveries).toEqual(["start:listening"]);
    firstDelivery.resolve();
    await vi.waitFor(() =>
      expect(deliveries).toEqual([
        "start:listening",
        "end:listening",
        "start:speaking",
        "end:speaking",
      ]),
    );
  });

  it("delivers the terminal close event after callback queue overflow", async () => {
    const firstDelivery = createDeferred();
    const deliveries: string[] = [];
    await openPluginTalkSession({
      sessionKey: "agent:main:avatar",
      signal: controller.signal,
      onEvent: async (event) => {
        deliveries.push(event.type);
        if (deliveries.length === 1) {
          await firstDelivery.promise;
        }
      },
    });
    const eventSink = capturedDispatchContext().eventSink;

    eventSink({ relaySessionId: "relay-1", type: "ready" });
    for (let index = 0; index < 129; index += 1) {
      eventSink({ relaySessionId: "relay-1", type: "audio", audioBase64: "" });
    }

    await vi.waitFor(() => expect(mocks.stopSession).toHaveBeenCalledOnce());
    eventSink({ relaySessionId: "relay-1", type: "close", reason: "error" });
    firstDelivery.resolve();

    await vi.waitFor(() => expect(deliveries).toEqual(["state", "closed"]));
  });

  it("rejects plugin routes without Talk access", async () => {
    mocks.scope.mockReturnValue({
      pluginId: "avatar",
      gatewayMethodDispatchAllowed: true,
      routeSignal: controller.signal,
      client: {
        connId: "plugin-http:127.0.0.1",
        connect: { scopes: ["operator.read"] },
      },
      context: { logGateway: { warn: mocks.warn } },
    });

    await expect(
      openPluginTalkSession({
        sessionKey: "agent:main:avatar",
        signal: controller.signal,
        onEvent: vi.fn(),
      }),
    ).rejects.toThrow("authenticated plugin request with Talk access");
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("requires an entitled request scope and a selected agent session", async () => {
    mocks.scope.mockReturnValue(undefined);
    await expect(
      openPluginTalkSession({
        sessionKey: "agent:main:avatar",
        signal: controller.signal,
        onEvent: vi.fn(),
      }),
    ).rejects.toThrow("gatewayMethodDispatch contract");

    await expect(
      openPluginTalkSession({ sessionKey: " ", signal: controller.signal, onEvent: vi.fn() }),
    ).rejects.toThrow("intended agent and workspace");
  });

  it("closes the relay when its consuming connection ends", async () => {
    await openPluginTalkSession({
      sessionKey: "agent:main:avatar",
      signal: controller.signal,
      onEvent: vi.fn(),
    });
    const createParams = capturedDispatchContext();

    controller.abort();

    expect(mocks.stopSession).toHaveBeenCalledWith({
      relaySessionId: "relay-1",
      connId: createParams.ownerId,
      disposition: "detach",
    });
  });

  it("closes the relay when the host route lifetime ends", async () => {
    await openPluginTalkSession({
      sessionKey: "agent:main:avatar",
      signal: controller.signal,
      onEvent: vi.fn(),
    });
    const createParams = capturedDispatchContext();

    routeController.abort(new Error("plugin route disconnected"));

    expect(mocks.stopSession).toHaveBeenCalledWith({
      relaySessionId: "relay-1",
      connId: createParams.ownerId,
      disposition: "detach",
    });
  });

  it("closes a relay that finishes opening after its connection ends", async () => {
    let resolveSession: ((session: { relaySessionId: string }) => void) | undefined;
    mocks.dispatch.mockImplementationOnce(async () => {
      dispatchContexts.push(requireDispatchContext());
      return await new Promise((resolve) => {
        resolveSession = resolve;
      });
    });
    const opening = openPluginTalkSession({
      sessionKey: "agent:main:avatar",
      signal: controller.signal,
      onEvent: vi.fn(),
    });
    const createParams = capturedDispatchContext();

    controller.abort(new Error("browser disconnected"));
    resolveSession?.({ relaySessionId: "relay-late" });

    await expect(opening).rejects.toThrow("browser disconnected");
    expect(mocks.stopSession).toHaveBeenCalledWith({
      relaySessionId: "relay-late",
      connId: createParams.ownerId,
      disposition: "detach",
    });
  });
});
