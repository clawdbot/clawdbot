import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type GatewayMethod = (options: {
  params?: { callId?: unknown };
  respond: (ok: boolean, result?: unknown, error?: unknown) => void;
}) => Promise<void>;

type FixturePlugin = {
  register(api: {
    registerGatewayMethod(method: string, handler: GatewayMethod): void;
    registerRealtimeVoiceProvider(provider: unknown): void;
  }): void;
};

const runtimeCoordinatorKey = Symbol.for("openclaw.voice-call.runtimeCoordinator");
const unavailableError = {
  code: "UNAVAILABLE",
  message: "Voice Call runtime stream issuer unavailable",
};
const fixtureUrl = pathToFileURL(
  path.resolve("test/e2e/qa-lab/runtime/fixtures/voice-call-runtime-plugin/index.js"),
).href;
const { default: fixturePlugin } = (await import(fixtureUrl)) as { default: FixturePlugin };

function setRuntimeCoordinator(coordinator: unknown): void {
  (globalThis as Record<PropertyKey, unknown>)[runtimeCoordinatorKey] = coordinator;
}

function registerStreamSessionMethod(): GatewayMethod {
  let streamSessionMethod: GatewayMethod | undefined;
  fixturePlugin.register({
    registerGatewayMethod(method, handler) {
      if (method === "qa.voiceCall.streamSession") {
        streamSessionMethod = handler;
      }
    },
    registerRealtimeVoiceProvider() {},
  });
  if (!streamSessionMethod) {
    throw new Error("Voice Call fixture did not register qa.voiceCall.streamSession");
  }
  return streamSessionMethod;
}

async function expectUnavailable(streamSessionMethod: GatewayMethod): Promise<void> {
  const respond = vi.fn();
  await streamSessionMethod({ params: { callId: "call-123" }, respond });
  expect(respond).toHaveBeenCalledOnce();
  expect(respond).toHaveBeenCalledWith(false, undefined, unavailableError);
}

describe("Voice Call runtime fixture", () => {
  beforeEach(() => {
    delete (globalThis as Record<PropertyKey, unknown>)[runtimeCoordinatorKey];
  });

  afterEach(() => {
    delete (globalThis as Record<PropertyKey, unknown>)[runtimeCoordinatorKey];
    vi.restoreAllMocks();
  });

  it("returns unavailable without a runtime coordinator", async () => {
    await expectUnavailable(registerStreamSessionMethod());
  });

  it.each(["starting", "stopping"] as const)(
    "returns unavailable while the runtime is %s",
    async (state) => {
      const owner = {};
      setRuntimeCoordinator({
        current: owner,
        slot: { state, owner, promise: Promise.resolve() },
      });

      await expectUnavailable(registerStreamSessionMethod());
    },
  );

  it("returns unavailable for a running slot owned by a stale generation", async () => {
    const getCall = vi.fn();
    const streamSessionIssuer = vi.fn();
    setRuntimeCoordinator({
      current: {},
      slot: {
        state: "running",
        owner: {},
        runtime: { manager: { getCall, streamSessionIssuer } },
      },
    });

    await expectUnavailable(registerStreamSessionMethod());
    expect(getCall).not.toHaveBeenCalled();
    expect(streamSessionIssuer).not.toHaveBeenCalled();
  });

  it("issues a stream session from the current running generation", async () => {
    const callId = "call-123";
    const owner = {};
    const call = {
      providerCallId: "provider-call-456",
      from: "+15550000001",
      to: "+15550000002",
      direction: "outbound",
    };
    const getCall = vi.fn(() => call);
    const streamSessionIssuer = vi.fn(() => ({
      streamUrl: "wss://voice.example.test/stream",
      token: "stream-token",
    }));
    setRuntimeCoordinator({
      current: owner,
      slot: {
        state: "running",
        owner,
        runtime: {
          manager: { getCall, streamSessionIssuer },
          webhookUrl: "https://voice.example.test/webhook",
        },
      },
    });
    const respond = vi.fn();

    await registerStreamSessionMethod()({ params: { callId }, respond });

    expect(getCall).toHaveBeenCalledOnce();
    expect(getCall).toHaveBeenCalledWith(callId);
    expect(streamSessionIssuer).toHaveBeenCalledOnce();
    expect(streamSessionIssuer).toHaveBeenCalledWith({
      providerName: "twilio",
      callId,
      from: call.from,
      to: call.to,
      direction: call.direction,
    });
    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(true, {
      streamUrl: "wss://voice.example.test/stream",
      token: "stream-token",
      providerCallId: call.providerCallId,
      webhookUrl: "https://voice.example.test/webhook",
    });
  });
});
