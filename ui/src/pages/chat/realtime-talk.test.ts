// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import * as gatewayRelayTransport from "./realtime-talk-gateway-relay.ts";
import * as googleLiveTransport from "./realtime-talk-google-live.ts";
import { useRealtimeTalkMicrophoneFixture } from "./realtime-talk-input.test-support.ts";
import { createRealtimeTalkEventEmitter } from "./realtime-talk-shared.ts";
import type {
  RealtimeTalkTransport,
  RealtimeTalkTransportContext,
} from "./realtime-talk-shared.ts";
import * as webRtcTransport from "./realtime-talk-webrtc.ts";

const {
  googleStart,
  googleStop,
  relayStart,
  relayStop,
  webRtcStart,
  webRtcStop,
  googleSetVideoEnabled,
  webRtcSetVideoEnabled,
  googleSwitchCamera,
  webRtcSwitchCamera,
} = {
  googleStart: vi.fn(async () => "ready" as const),
  googleStop: vi.fn(),
  relayStart: vi.fn(async () => "ready" as const),
  relayStop: vi.fn(),
  webRtcStart: vi.fn(async () => "ready" as const),
  webRtcStop: vi.fn(),
  googleSetVideoEnabled: vi.fn(async () => undefined),
  webRtcSetVideoEnabled: vi.fn(async () => undefined),
  googleSwitchCamera: vi.fn(async () => undefined),
  webRtcSwitchCamera: vi.fn(async () => undefined),
};

import { RealtimeTalkSession, switchActiveRealtimeTalkCameras } from "./realtime-talk.ts";

type MockTransport = RealtimeTalkTransport & { ctx: RealtimeTalkTransportContext };

const googleInstances: MockTransport[] = [];
const relayInstances: MockTransport[] = [];
const webRtcInstances: MockTransport[] = [];
const requestTimeoutOptions = { timeoutMs: 30_000 };

function transportContext(transport: object | undefined): RealtimeTalkTransportContext {
  if (!transport) {
    throw new Error("Expected realtime transport instance");
  }
  return (transport as { ctx: RealtimeTalkTransportContext }).ctx;
}

function talkRequests(responses: Record<string, () => unknown>) {
  const handlers = new Map(Object.entries(responses));
  return vi.fn(async (method: string) => {
    const respond = handlers.get(method);
    if (!respond) {
      throw new Error(`Unexpected request: ${method}`);
    }
    return respond();
  });
}

function relaySession(provider: string) {
  return {
    provider,
    transport: "gateway-relay",
    relaySessionId: "relay-1",
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: 24000,
      outputEncoding: "pcm16",
      outputSampleRateHz: 24000,
    },
  };
}

function configWithGoogleAuth(provider?: string) {
  return {
    talk: {
      realtime: {
        ...(provider ? { provider } : {}),
        providers: { google: { authMethod: "api-key" }, openai: {} },
      },
    },
  };
}

useRealtimeTalkMicrophoneFixture();

describe("RealtimeTalkSession", () => {
  it.each([
    { model: "gpt-live-1-codex", authMethod: "oauth" },
    { model: "gpt-realtime-2.1", authMethod: "api-key" },
  ])(
    "displays confirmed $model/$authMethod identity only for its active call",
    async ({ model, authMethod }) => {
      const ready = createDeferred<"ready">();
      webRtcStart.mockImplementationOnce(() => ready.promise);
      const payload = {
        provider: "openai",
        model,
        authMethod,
        voice: "test-voice",
        transport: "webrtc",
        voiceSessionId: "identity-call",
        clientSecret: "do-not-display-ephemeral",
      };
      const request = vi.fn(async () => payload);
      const session = new RealtimeTalkSession({ request } as never, "main");
      const starting = session.start();
      await vi.waitFor(() => expect(webRtcInstances).toHaveLength(1));
      expect(session.activeIdentity).toBeNull();
      ready.resolve("ready");
      await starting;
      expect(session.activeIdentity).toContain(model);
      expect(session.activeIdentity).toContain(authMethod);
      expect(session.activeIdentity).toContain("test-voice");
      expect(session.activeIdentity).toContain("webrtc");
      expect(session.activeIdentity).not.toContain(payload.clientSecret);
      payload.model = "next-call-model";
      expect(session.activeIdentity).toContain(model);
      session.stop();
      expect(session.activeIdentity).toBeNull();
    },
  );

  beforeEach(() => {
    googleStart.mockClear();
    googleStop.mockClear();
    relayStart.mockClear();
    relayStop.mockClear();
    webRtcStart.mockClear();
    webRtcStop.mockClear();
    googleSetVideoEnabled.mockClear();
    webRtcSetVideoEnabled.mockClear();
    googleSwitchCamera.mockClear();
    webRtcSwitchCamera.mockClear();
    googleInstances.length = 0;
    relayInstances.length = 0;
    webRtcInstances.length = 0;
    vi.spyOn(googleLiveTransport, "GoogleLiveRealtimeTalkTransport").mockImplementation(
      function (_session, ctx) {
        const transport: MockTransport = {
          ctx,
          start: googleStart,
          stop: googleStop,
          setVideoEnabled: googleSetVideoEnabled,
          switchCamera: googleSwitchCamera,
        };
        googleInstances.push(transport);
        return transport as unknown as googleLiveTransport.GoogleLiveRealtimeTalkTransport;
      },
    );
    vi.spyOn(gatewayRelayTransport, "GatewayRelayRealtimeTalkTransport").mockImplementation(
      function (_session, ctx) {
        const transport: MockTransport = { ctx, start: relayStart, stop: relayStop };
        relayInstances.push(transport);
        return transport as unknown as gatewayRelayTransport.GatewayRelayRealtimeTalkTransport;
      },
    );
    vi.spyOn(webRtcTransport, "WebRtcSdpRealtimeTalkTransport").mockImplementation(
      function (_session, ctx) {
        const transport: MockTransport = {
          ctx,
          start: webRtcStart,
          stop: webRtcStop,
          setVideoEnabled: webRtcSetVideoEnabled,
          switchCamera: webRtcSwitchCamera,
        };
        webRtcInstances.push(transport);
        return transport as unknown as webRtcTransport.WebRtcSdpRealtimeTalkTransport;
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts the Google Live WebSocket transport from a generic session result", async () => {
    const request = vi.fn(async () => ({
      provider: "google",
      voiceSessionId: "voice-1",
      transport: "provider-websocket",
      protocol: "google-live-bidi",
      clientSecret: "auth_tokens/session",
      websocketUrl: "wss://example.test/live",
      audio: {
        inputEncoding: "pcm16",
        inputSampleRateHz: 16000,
        outputEncoding: "pcm16",
        outputSampleRateHz: 24000,
      },
    }));
    const onStatus = vi.fn();
    const session = new RealtimeTalkSession({ request } as never, "main", { onStatus });

    await session.start();

    expect(request).toHaveBeenCalledWith(
      "talk.client.create",
      {
        sessionKey: "main",
        capabilities: ["voice-transcript"],
      },
      requestTimeoutOptions,
    );
    expect(googleInstances).toHaveLength(1);
    expect(googleStart).toHaveBeenCalledTimes(1);
    expect(webRtcInstances).toHaveLength(0);
    expect(relayInstances).toHaveLength(0);
    expect(onStatus).toHaveBeenCalledWith("connecting", "Preparing voice session...");
  });

  it("defaults legacy session results without an explicit transport to WebRTC", async () => {
    const request = vi.fn(async () => ({
      provider: "openai",
      voiceSessionId: "voice-1",
      clientSecret: "auth_tokens/session",
    }));
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();

    expect(webRtcInstances).toHaveLength(1);
    expect(webRtcStart).toHaveBeenCalledTimes(1);
    expect(googleInstances).toHaveLength(0);
  });

  it.each(["webrtc", "provider-websocket"] as const)(
    "closes a failed %s voice owner after draining transcripts without hiding the error",
    async (transport) => {
      const saved = createDeferred<unknown>();
      let generation = 0;
      const result = () => ({
        provider: transport === "webrtc" ? "openai" : "google",
        voiceSessionId: `voice-${++generation}`,
        transport,
        clientSecret: "test-session",
      });
      const request = vi.fn((method: string) => {
        if (method === "talk.client.create") {
          return Promise.resolve(result());
        }
        if (method === "talk.client.transcript") {
          return saved.promise;
        }
        return Promise.resolve({ ok: true });
      });
      const onStatus = vi.fn();
      const session = new RealtimeTalkSession({ request } as never, "main", { onStatus });
      await session.start();
      const instances = transport === "webrtc" ? webRtcInstances : googleInstances;
      const stop = transport === "webrtc" ? webRtcStop : googleStop;
      const ctx = transportContext(instances[0]);
      const emit = createRealtimeTalkEventEmitter(ctx, {
        provider: "test",
        transport: "webrtc",
        clientSecret: "test-session",
      });
      ctx.callbacks.onTranscript?.({ role: "user", text: "Keep this utterance", final: true });
      ctx.callbacks.onStatus?.("error", "Microphone disconnected");
      emit({ type: "session.closed", final: true });
      expect(stop).toHaveBeenCalledOnce();
      expect(onStatus).toHaveBeenLastCalledWith("error", "Microphone disconnected");
      expect(request.mock.calls.filter(([method]) => method === "talk.client.close")).toEqual([]);
      saved.resolve({ ok: true });
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          "talk.client.close",
          { sessionKey: "main", voiceSessionId: "voice-1" },
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ),
      );
      await session.start();
      emit({ type: "session.closed", final: true });
      expect(stop).toHaveBeenCalledOnce();
      expect(request.mock.calls.filter(([method]) => method === "talk.client.close")).toHaveLength(
        1,
      );
      session.stop();
    },
  );

  it("accepts legacy WebRTC transport names", async () => {
    const request = vi.fn(async () => ({
      provider: "openai",
      voiceSessionId: "voice-1",
      transport: "webrtc-sdp",
      clientSecret: "secret",
    }));
    const client = { request } as never;
    const session = new RealtimeTalkSession(client, "main");

    await session.start();

    expect(webRtcInstances).toHaveLength(1);
    expect(googleInstances).toHaveLength(0);
  });

  it("accepts legacy provider WebSocket transport names", async () => {
    const request = vi.fn(async () => ({
      provider: "example",
      voiceSessionId: "voice-1",
      transport: "json-pcm-websocket",
      clientSecret: "secret",
      protocol: "google-live-bidi",
      websocketUrl: "wss://example.test/live",
      audio: {
        inputEncoding: "pcm16",
        inputSampleRateHz: 16000,
        outputEncoding: "pcm16",
        outputSampleRateHz: 24000,
      },
    }));
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();

    expect(webRtcInstances).toHaveLength(0);
    expect(googleInstances).toHaveLength(1);
  });

  it("starts the Gateway relay transport for backend-only realtime providers", async () => {
    const request = vi.fn(async () => ({
      provider: "example",
      transport: "gateway-relay",
      relaySessionId: "relay-1",
      audio: {
        inputEncoding: "pcm16",
        inputSampleRateHz: 24000,
        outputEncoding: "pcm16",
        outputSampleRateHz: 24000,
      },
    }));
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();
    session.stop();

    expect(relayInstances).toHaveLength(1);
    expect(relayStart).toHaveBeenCalledTimes(1);
    expect(relayStop).toHaveBeenCalledTimes(1);
    expect(googleInstances).toHaveLength(0);
    expect(webRtcInstances).toHaveLength(0);
  });

  it("closes a Gateway relay allocated after the session stops", async () => {
    const create = createDeferred<{
      provider: string;
      transport: "gateway-relay";
      relaySessionId: string;
      audio: {
        inputEncoding: "pcm16";
        inputSampleRateHz: number;
        outputEncoding: "pcm16";
        outputSampleRateHz: number;
      };
    }>();
    const request = vi.fn((method: string) => {
      if (method === "talk.client.create") {
        return create.promise;
      }
      if (method === "talk.session.close") {
        return Promise.resolve({ ok: true });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const session = new RealtimeTalkSession({ request } as never, "main");

    const starting = session.start();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "talk.client.create",
        expect.anything(),
        requestTimeoutOptions,
      ),
    );
    session.stop();
    create.resolve({
      provider: "openai",
      transport: "gateway-relay",
      relaySessionId: "relay-stale",
      audio: {
        inputEncoding: "pcm16",
        inputSampleRateHz: 24_000,
        outputEncoding: "pcm16",
        outputSampleRateHz: 24_000,
      },
    });
    await starting;

    expect(request).toHaveBeenCalledWith(
      "talk.session.close",
      { sessionId: "relay-stale" },
      { timeoutMs: 30_000 },
    );
    expect(relayInstances).toHaveLength(0);
  });

  it("closes a superseded client-owned allocation without replacing the active call", async () => {
    const creates: Array<ReturnType<typeof createDeferred<unknown>>> = [];
    const request = vi.fn((method: string) => {
      if (method === "talk.client.create") {
        const create = createDeferred<unknown>();
        creates.push(create);
        return create.promise;
      }
      if (method === "talk.client.close") {
        return Promise.resolve({ ok: true });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as never;
    const session = new RealtimeTalkSession(client, "main");

    const firstStart = session.start();
    await vi.waitFor(() => expect(creates).toHaveLength(1));
    session.stop();
    const secondStart = session.start();
    await vi.waitFor(() => expect(creates).toHaveLength(2));
    creates[1]!.resolve({
      provider: "openai",
      transport: "webrtc",
      voiceSessionId: "voice-current",
      clientSecret: "secret",
    });
    await secondStart;
    const blocked = new RealtimeTalkSession(client, "main");
    await expect(blocked.start()).rejects.toThrow(
      "Too many active or closing realtime Talk voice sessions",
    );
    expect(creates).toHaveLength(2);
    creates[0]!.resolve({
      provider: "openai",
      transport: "webrtc",
      voiceSessionId: "voice-stale",
      clientSecret: "secret",
    });
    await firstStart;

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "talk.client.close",
        {
          sessionKey: "main",
          voiceSessionId: "voice-stale",
        },
        {
          signal: expect.any(AbortSignal),
          timeoutMs: 30_000,
        },
      ),
    );
    expect(webRtcInstances).toHaveLength(1);
    expect(webRtcStart).toHaveBeenCalledTimes(1);
    session.stop();
  });

  it("falls back to talk.session.create when gateway-relay is rejected by talk.client.create", async () => {
    const request = talkRequests({
      "talk.catalog": () => ({ realtime: { activeProvider: "xai", providers: [{ id: "xai" }] } }),
      "talk.client.create": () => {
        throw new Error("talk.client.create is client-owned; use talk.session.create");
      },
      "talk.session.create": () => relaySession("example"),
    });
    const session = new RealtimeTalkSession(
      { request } as never,
      "main",
      {},
      { provider: "xai", transport: "gateway-relay" },
    );

    await session.start();

    expect(request).toHaveBeenNthCalledWith(
      2,
      "talk.client.create",
      {
        sessionKey: "main",
        provider: "xai",
        transport: "gateway-relay",
        capabilities: ["voice-transcript"],
      },
      requestTimeoutOptions,
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      "talk.session.create",
      {
        sessionKey: "main",
        provider: "xai",
        transport: "gateway-relay",
        mode: "realtime",
        brain: "agent-consult",
      },
      requestTimeoutOptions,
    );
    expect(relayInstances).toHaveLength(1);
    expect(relayStart).toHaveBeenCalledTimes(1);
  });

  it("strips browser capabilities and hides camera when falling back to Gateway relay", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.catalog") {
        return {
          realtime: {
            activeProvider: "openai",
            providers: [{ id: "openai", label: "OpenAI", supportsVideoFrames: true }],
          },
        };
      }
      if (method === "talk.client.create") {
        throw new Error("browser session unavailable");
      }
      if (method === "talk.session.create") {
        return {
          provider: "openai",
          transport: "gateway-relay",
          relaySessionId: "relay-1",
          audio: {
            inputEncoding: "pcm16",
            inputSampleRateHz: 24000,
            outputEncoding: "pcm16",
            outputSampleRateHz: 24000,
          },
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const onVideoCapability = vi.fn();
    const session = new RealtimeTalkSession(
      { request } as never,
      "main",
      { onVideoCapability },
      { provider: "openai", transport: "gateway-relay" },
    );

    await session.start();

    expect(request).toHaveBeenNthCalledWith(
      2,
      "talk.client.create",
      {
        sessionKey: "main",
        provider: "openai",
        transport: "gateway-relay",
        capabilities: ["voice-transcript", "camera-frame"],
      },
      requestTimeoutOptions,
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      "talk.session.create",
      {
        sessionKey: "main",
        provider: "openai",
        transport: "gateway-relay",
        mode: "realtime",
        brain: "agent-consult",
      },
      requestTimeoutOptions,
    );
    expect(onVideoCapability).toHaveBeenCalledOnce();
    expect(onVideoCapability).toHaveBeenCalledWith(false);
    expect(relayInstances).toHaveLength(1);
  });

  it("starts the WebRTC transport for canonical WebRTC sessions", async () => {
    const request = vi.fn(async () => ({
      provider: "openai",
      voiceSessionId: "voice-1",
      transport: "webrtc",
      clientSecret: "secret",
    }));
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();
    session.stop();

    expect(webRtcInstances).toHaveLength(1);
    expect(webRtcStart).toHaveBeenCalledTimes(1);
    expect(webRtcStop).toHaveBeenCalledTimes(1);
    expect(googleInstances).toHaveLength(0);
    expect(relayInstances).toHaveLength(0);
  });

  it("passes launch options to client-owned realtime session creation", async () => {
    const request = vi.fn(async () => ({
      provider: "openai",
      voiceSessionId: "voice-1",
      transport: "webrtc",
      clientSecret: "secret",
    }));
    const session = new RealtimeTalkSession(
      { request } as never,
      "main",
      {},
      {
        provider: "openai",
        model: "gpt-realtime-2",
        voice: "marin",
        transport: "webrtc",
        vadThreshold: 0.45,
        silenceDurationMs: 650,
        prefixPaddingMs: 250,
        reasoningEffort: "low",
      },
      { inputDeviceId: "usb-mic", videoDeviceId: "desk-camera" },
    );

    await session.start();

    expect(request).toHaveBeenCalledWith(
      "talk.client.create",
      {
        sessionKey: "main",
        provider: "openai",
        model: "gpt-realtime-2",
        voice: "marin",
        transport: "webrtc",
        vadThreshold: 0.45,
        silenceDurationMs: 650,
        prefixPaddingMs: 250,
        reasoningEffort: "low",
        capabilities: ["voice-transcript"],
      },
      requestTimeoutOptions,
    );
    expect(transportContext(webRtcInstances[0])).toEqual(
      expect.objectContaining({ videoDeviceId: "desk-camera" }),
    );
  });

  it("requests camera-frame for the active video-capable provider without enabling camera", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.catalog") {
        return {
          realtime: {
            activeProvider: "openai",
            providers: [{ id: "openai", label: "OpenAI", supportsVideoFrames: true }],
          },
        };
      }
      return {
        provider: "openai",
        voiceSessionId: "voice-1",
        transport: "webrtc",
        clientSecret: "secret",
      };
    });
    const onVideoCapability = vi.fn();
    const session = new RealtimeTalkSession({ request } as never, "main", {
      onVideoCapability,
    });

    await session.start();

    expect(request).toHaveBeenNthCalledWith(1, "talk.catalog", {}, requestTimeoutOptions);
    expect(request).toHaveBeenNthCalledWith(
      2,
      "talk.client.create",
      {
        sessionKey: "main",
        capabilities: ["voice-transcript", "camera-frame"],
      },
      requestTimeoutOptions,
    );
    expect(onVideoCapability).toHaveBeenCalledWith(true);
    expect(transportContext(webRtcInstances[0])).toEqual(
      expect.not.objectContaining({ videoEnabled: expect.anything() }),
    );

    await session.setVideoEnabled(true);
    expect(webRtcSetVideoEnabled).toHaveBeenCalledWith(true);

    await session.switchCamera("back-camera");
    expect(webRtcSwitchCamera).toHaveBeenCalledWith("back-camera");
    session.stop();
  });

  it("applies a Settings camera selection to an active video session", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.catalog") {
        return {
          realtime: {
            activeProvider: "openai",
            providers: [{ id: "openai", label: "OpenAI", supportsVideoFrames: true }],
          },
        };
      }
      return {
        provider: "openai",
        transport: "webrtc",
        voiceSessionId: "voice-settings-camera",
        clientSecret: "secret",
      };
    });
    const session = new RealtimeTalkSession({ request } as never, "main", {
      onVideoCapability: vi.fn(),
    });

    await session.start();
    await session.setVideoEnabled(true);
    await switchActiveRealtimeTalkCameras("back-camera");

    expect(webRtcSwitchCamera).toHaveBeenCalledWith("back-camera");
    session.stop();
  });

  it("tracks a pending camera enable without retaining a stopped session", async () => {
    let resolveEnable: (value: undefined) => void = () => undefined;
    webRtcSetVideoEnabled.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveEnable = resolve;
        }),
    );
    const request = vi.fn(async (method: string) => {
      if (method === "talk.catalog") {
        return {
          realtime: {
            activeProvider: "openai",
            providers: [{ id: "openai", label: "OpenAI", supportsVideoFrames: true }],
          },
        };
      }
      return {
        provider: "openai",
        transport: "webrtc",
        voiceSessionId: "voice-pending-camera",
        clientSecret: "secret",
      };
    });
    const session = new RealtimeTalkSession({ request } as never, "main", {
      onVideoCapability: vi.fn(),
    });

    await session.start();
    const enabling = session.setVideoEnabled(true);
    await switchActiveRealtimeTalkCameras("back-camera");
    expect(webRtcSwitchCamera).toHaveBeenCalledOnce();

    session.stop();
    resolveEnable(undefined);
    await enabling;
    await switchActiveRealtimeTalkCameras("desk-camera");
    expect(webRtcSwitchCamera).toHaveBeenCalledOnce();
  });

  it("does not request camera-frame for a provider without video-frame support", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.catalog") {
        return {
          realtime: {
            activeProvider: "openai",
            providers: [{ id: "openai", label: "OpenAI", supportsVideoFrames: false }],
          },
        };
      }
      return {
        provider: "openai",
        voiceSessionId: "voice-1",
        transport: "webrtc",
        clientSecret: "secret",
      };
    });
    const onVideoCapability = vi.fn();
    const session = new RealtimeTalkSession({ request } as never, "main", {
      onVideoCapability,
    });

    await session.start();

    expect(request).toHaveBeenNthCalledWith(
      2,
      "talk.client.create",
      {
        sessionKey: "main",
        capabilities: ["voice-transcript"],
      },
      requestTimeoutOptions,
    );
    expect(onVideoCapability).toHaveBeenCalledWith(false);
  });

  it.each([
    [
      "a configured client transport",
      { config: { talk: { realtime: { transport: "provider-websocket" } } } },
    ],
    [
      "an invalid transport",
      { config: { talk: { realtime: { transport: "invalid-transport" } } } },
    ],
    ["unreadable configuration", new Error("config unavailable")],
    ["a missing config payload", {}],
  ] as const)("does not recover through relay with %s", async (_name, configResult) => {
    const clientError = new Error("browser session unavailable");
    const request = talkRequests({
      "talk.catalog": () => ({
        realtime: { activeProvider: "openai", providers: [{ id: "openai" }] },
      }),
      "talk.client.create": () => {
        throw clientError;
      },
      "talk.config": () => {
        if (configResult instanceof Error) {
          throw configResult;
        }
        return configResult;
      },
    });
    const session = new RealtimeTalkSession({ request } as never, "main");
    await expect(session.start()).rejects.toBe(clientError);
    expect(request.mock.calls).toEqual([
      ["talk.catalog", {}, requestTimeoutOptions],
      [
        "talk.client.create",
        { sessionKey: "main", capabilities: ["voice-transcript"] },
        requestTimeoutOptions,
      ],
      ["talk.config", {}, requestTimeoutOptions],
    ]);
    expect(relayInstances).toHaveLength(0);
  });

  it("never replaces an explicit per-call client transport with saved relay config", async () => {
    const clientError = new Error("browser session unavailable");
    const request = talkRequests({
      "talk.client.create": () => {
        throw clientError;
      },
    });
    const session = new RealtimeTalkSession(
      { request } as never,
      "main",
      {},
      { transport: "webrtc" },
    );

    await expect(session.start()).rejects.toBe(clientError);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "talk.catalog",
      "talk.client.create",
    ]);
    expect(relayInstances).toHaveLength(0);
  });

  it("falls back to Gateway relay when config selects Gateway relay", async () => {
    const request = talkRequests({
      "talk.client.create": () => {
        throw new Error("browser session unavailable");
      },
      "talk.config": () => {
        return {
          config: {
            talk: {
              realtime: { transport: "gateway-relay" },
            },
          },
        };
      },
      "talk.session.create": () => relaySession("example"),
    });
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();

    expect(request).toHaveBeenNthCalledWith(
      4,
      "talk.session.create",
      {
        sessionKey: "main",
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
      },
      requestTimeoutOptions,
    );
    expect(relayInstances).toHaveLength(1);
    expect(relayStart).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["empty configuration", {}, undefined, "openai"],
    ["inactive legacy strict auth", configWithGoogleAuth("openai"), undefined, "openai"],
    ["providerless Auto", configWithGoogleAuth(), undefined, "openai"],
    ["a canonical per-call provider override", configWithGoogleAuth("google"), "openai", "google"],
    [
      "a normalized per-call provider alias",
      configWithGoogleAuth("google"),
      " TEST-OPENAI ",
      "google",
    ],
  ] as const)(
    "recovers a failed Auto client call with %s through Gateway relay",
    async (_name, config, provider, activeProvider) => {
      const request = talkRequests({
        "talk.catalog": () => {
          return {
            realtime: {
              activeProvider,
              providers: [
                { id: "google", aliases: ["test-google"] },
                { id: "openai", aliases: ["test-openai"] },
              ],
            },
          };
        },
        "talk.client.create": () => {
          throw new Error("browser session unavailable");
        },
        "talk.config": () => ({ config }),
        "talk.session.create": () => relaySession("openai"),
      });
      const session = new RealtimeTalkSession(
        { request } as never,
        "main",
        { onVideoCapability: vi.fn() },
        { provider },
      );
      try {
        await session.start();
        expect(request.mock.calls.map(([method]) => method)).toEqual([
          "talk.catalog",
          "talk.client.create",
          "talk.config",
          "talk.session.create",
        ]);
        expect(request).toHaveBeenNthCalledWith(
          3,
          "talk.config",
          provider ? { realtimeProvider: provider.trim() } : {},
          requestTimeoutOptions,
        );
        expect(relayInstances).toHaveLength(1);
        expect(relayStart).toHaveBeenCalledOnce();
      } finally {
        session.stop();
      }
    },
  );

  it.each([
    ["oauth", "openai", undefined, "openai"],
    ["api-key", "openai", undefined, "openai"],
    ["oauth", "test-openai", undefined, "openai"],
    ["oauth", "openai", " TEST-OPENAI ", "google"],
    ["oauth", "google", undefined, "openai"],
  ] as const)(
    "keeps %s auth for configured %s and requested %s strict (catalog active %s)",
    async (authMethod, provider, requestedProvider, activeProvider) => {
      const clientError = new Error("browser session unavailable");
      const request = talkRequests({
        "talk.catalog": () => {
          return {
            realtime: {
              activeProvider,
              providers: [{ id: "google" }, { id: "openai", aliases: ["test-openai"] }],
            },
          };
        },
        "talk.client.create": () => {
          throw clientError;
        },
        "talk.config": () => {
          const canonical = provider === "google" ? "google" : "openai";
          return {
            config: {
              talk: { realtime: { provider, providers: { [canonical]: { authMethod } } } },
            },
          };
        },
      });
      const session = new RealtimeTalkSession(
        { request } as never,
        "main",
        {},
        { provider: requestedProvider },
      );
      await expect(session.start()).rejects.toBe(clientError);
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "talk.catalog",
        "talk.client.create",
        "talk.config",
      ]);
      expect(relayInstances).toHaveLength(0);
    },
  );

  it("keeps unknown catalog selection fail-closed when projected auth is explicit", async () => {
    const clientError = new Error("browser session unavailable");
    const request = talkRequests({
      "talk.catalog": () => {
        throw new Error("catalog unavailable");
      },
      "talk.client.create": () => {
        throw clientError;
      },
      "talk.config": () => {
        return {
          config: { talk: { realtime: { providers: { openai: { authMethod: "oauth" } } } } },
        };
      },
    });
    const session = new RealtimeTalkSession({ request } as never, "main");
    await expect(session.start()).rejects.toBe(clientError);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "talk.catalog",
      "talk.client.create",
      "talk.config",
    ]);
    expect(relayInstances).toHaveLength(0);
  });
});
