// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import * as gatewayRelayTransport from "./realtime-talk-gateway-relay.ts";
import * as googleLiveTransport from "./realtime-talk-google-live.ts";
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

describe("RealtimeTalkSession", () => {
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
    expect(onStatus).toHaveBeenCalledWith("connecting");
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
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("talk.client.create is client-owned; use talk.session.create"),
      )
      .mockResolvedValueOnce({
        provider: "example",
        transport: "gateway-relay",
        relaySessionId: "relay-1",
        audio: {
          inputEncoding: "pcm16",
          inputSampleRateHz: 24000,
          outputEncoding: "pcm16",
          outputSampleRateHz: 24000,
        },
      });
    const session = new RealtimeTalkSession(
      { request } as never,
      "main",
      {},
      { provider: "xai", transport: "gateway-relay" },
    );

    await session.start();

    expect(request).toHaveBeenNthCalledWith(
      1,
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
      2,
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
      expect.objectContaining({ inputDeviceId: "usb-mic", videoDeviceId: "desk-camera" }),
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

  it("does not fall back to Gateway relay when config selects a client transport", async () => {
    const clientError = new Error("browser session unavailable");
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        throw clientError;
      }
      if (method === "talk.config") {
        return {
          config: {
            talk: {
              realtime: { transport: "provider-websocket" },
            },
          },
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const session = new RealtimeTalkSession({ request } as never, "main");

    await expect(session.start()).rejects.toBe(clientError);

    expect(request.mock.calls).toEqual([
      [
        "talk.client.create",
        { sessionKey: "main", capabilities: ["voice-transcript"] },
        requestTimeoutOptions,
      ],
      ["talk.config", {}, requestTimeoutOptions],
    ]);
    expect(relayInstances).toHaveLength(0);
  });

  it("falls back to Gateway relay when config selects Gateway relay", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        throw new Error("browser session unavailable");
      }
      if (method === "talk.config") {
        return {
          config: {
            talk: {
              realtime: { transport: "gateway-relay" },
            },
          },
        };
      }
      if (method === "talk.session.create") {
        return {
          provider: "example",
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
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();

    expect(request).toHaveBeenNthCalledWith(
      3,
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

  it("falls back to Gateway relay when a successful config read resolves Auto", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        throw new Error("browser session unavailable");
      }
      if (method === "talk.config") {
        return { config: {} };
      }
      if (method === "talk.session.create") {
        return {
          provider: "example",
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
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();

    expect(request).toHaveBeenNthCalledWith(
      3,
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
  });

  it("does not fall back when the effective config cannot be read", async () => {
    const clientError = new Error("browser session unavailable");
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        throw clientError;
      }
      if (method === "talk.config") {
        throw new Error("config unavailable");
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const session = new RealtimeTalkSession({ request } as never, "main");

    await expect(session.start()).rejects.toBe(clientError);

    expect(request.mock.calls).toEqual([
      [
        "talk.client.create",
        { sessionKey: "main", capabilities: ["voice-transcript"] },
        requestTimeoutOptions,
      ],
      ["talk.config", {}, requestTimeoutOptions],
    ]);
    expect(relayInstances).toHaveLength(0);
  });

  it("does not fall back when the effective config payload is missing", async () => {
    const clientError = new Error("browser session unavailable");
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        throw clientError;
      }
      if (method === "talk.config") {
        return {};
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const session = new RealtimeTalkSession({ request } as never, "main");

    await expect(session.start()).rejects.toBe(clientError);

    expect(request.mock.calls).toEqual([
      [
        "talk.client.create",
        { sessionKey: "main", capabilities: ["voice-transcript"] },
        requestTimeoutOptions,
      ],
      ["talk.config", {}, requestTimeoutOptions],
    ]);
    expect(relayInstances).toHaveLength(0);
  });
});
