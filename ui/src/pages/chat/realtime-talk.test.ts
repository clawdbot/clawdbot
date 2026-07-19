// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  googleCtor,
  relayCtor,
  webRtcCtor,
} = vi.hoisted(() => ({
  googleStart: vi.fn(async () => undefined),
  googleStop: vi.fn(),
  relayStart: vi.fn(async () => undefined),
  relayStop: vi.fn(),
  webRtcStart: vi.fn(async () => undefined),
  webRtcStop: vi.fn(),
  googleSetVideoEnabled: vi.fn(async () => undefined),
  webRtcSetVideoEnabled: vi.fn(async () => undefined),
  googleSwitchCamera: vi.fn(async () => undefined),
  webRtcSwitchCamera: vi.fn(async () => undefined),
  googleCtor: vi.fn(function () {
    return {
      start: googleStart,
      stop: googleStop,
      setVideoEnabled: googleSetVideoEnabled,
      switchCamera: googleSwitchCamera,
    };
  }),
  relayCtor: vi.fn(function () {
    return { start: relayStart, stop: relayStop };
  }),
  webRtcCtor: vi.fn(function () {
    return {
      start: webRtcStart,
      stop: webRtcStop,
      setVideoEnabled: webRtcSetVideoEnabled,
      switchCamera: webRtcSwitchCamera,
    };
  }),
}));

vi.mock("./realtime-talk-google-live.ts", () => ({
  GoogleLiveRealtimeTalkTransport: googleCtor,
}));

vi.mock("./realtime-talk-gateway-relay.ts", () => ({
  GatewayRelayRealtimeTalkTransport: relayCtor,
}));

vi.mock("./realtime-talk-webrtc.ts", () => ({
  WebRtcSdpRealtimeTalkTransport: webRtcCtor,
}));

import { RealtimeTalkSession, switchActiveRealtimeTalkCameras } from "./realtime-talk.ts";

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
    googleCtor.mockClear();
    relayCtor.mockClear();
    webRtcCtor.mockClear();
  });

  it("starts the Google Live WebSocket transport from a generic session result", async () => {
    const request = vi.fn(async () => ({
      provider: "google",
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

    expect(request).toHaveBeenCalledWith("talk.client.create", { sessionKey: "main" });
    expect(googleCtor).toHaveBeenCalledTimes(1);
    expect(googleStart).toHaveBeenCalledTimes(1);
    expect(webRtcCtor).not.toHaveBeenCalled();
    expect(relayCtor).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith("connecting");
  });

  it("defaults legacy session results without an explicit transport to WebRTC", async () => {
    const request = vi.fn(async () => ({
      provider: "openai",
      clientSecret: "auth_tokens/session",
    }));
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();

    expect(webRtcCtor).toHaveBeenCalledTimes(1);
    expect(webRtcStart).toHaveBeenCalledTimes(1);
    expect(googleCtor).not.toHaveBeenCalled();
  });

  it("accepts legacy WebRTC transport names", async () => {
    const request = vi.fn(async () => ({
      provider: "openai",
      transport: "webrtc-sdp",
      clientSecret: "secret",
    }));
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();

    expect(webRtcCtor).toHaveBeenCalledTimes(1);
    expect(googleCtor).not.toHaveBeenCalled();
  });

  it("accepts legacy provider WebSocket transport names", async () => {
    const request = vi.fn(async () => ({
      provider: "example",
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

    expect(webRtcCtor).not.toHaveBeenCalled();
    expect(googleCtor).toHaveBeenCalledTimes(1);
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

    expect(relayCtor).toHaveBeenCalledTimes(1);
    expect(relayStart).toHaveBeenCalledTimes(1);
    expect(relayStop).toHaveBeenCalledTimes(1);
    expect(googleCtor).not.toHaveBeenCalled();
    expect(webRtcCtor).not.toHaveBeenCalled();
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

    expect(request).toHaveBeenNthCalledWith(1, "talk.client.create", {
      sessionKey: "main",
      provider: "xai",
      transport: "gateway-relay",
    });
    expect(request).toHaveBeenNthCalledWith(2, "talk.session.create", {
      sessionKey: "main",
      provider: "xai",
      transport: "gateway-relay",
      mode: "realtime",
      brain: "agent-consult",
    });
    expect(relayCtor).toHaveBeenCalledTimes(1);
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

    expect(request).toHaveBeenNthCalledWith(2, "talk.client.create", {
      sessionKey: "main",
      provider: "openai",
      transport: "gateway-relay",
      capabilities: ["camera-frame"],
    });
    expect(request).toHaveBeenNthCalledWith(3, "talk.session.create", {
      sessionKey: "main",
      provider: "openai",
      transport: "gateway-relay",
      mode: "realtime",
      brain: "agent-consult",
    });
    expect(onVideoCapability).toHaveBeenCalledOnce();
    expect(onVideoCapability).toHaveBeenCalledWith(false);
    expect(relayCtor).toHaveBeenCalledTimes(1);
  });

  it("starts the WebRTC transport for canonical WebRTC sessions", async () => {
    const request = vi.fn(async () => ({
      provider: "openai",
      transport: "webrtc",
      clientSecret: "secret",
    }));
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();
    session.stop();

    expect(webRtcCtor).toHaveBeenCalledTimes(1);
    expect(webRtcStart).toHaveBeenCalledTimes(1);
    expect(webRtcStop).toHaveBeenCalledTimes(1);
    expect(googleCtor).not.toHaveBeenCalled();
    expect(relayCtor).not.toHaveBeenCalled();
  });

  it("passes launch options to client-owned realtime session creation", async () => {
    const request = vi.fn(async () => ({
      provider: "openai",
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

    expect(request).toHaveBeenCalledWith("talk.client.create", {
      sessionKey: "main",
      provider: "openai",
      model: "gpt-realtime-2",
      voice: "marin",
      transport: "webrtc",
      vadThreshold: 0.45,
      silenceDurationMs: 650,
      prefixPaddingMs: 250,
      reasoningEffort: "low",
    });
    expect(webRtcCtor).toHaveBeenCalledWith(
      expect.any(Object),
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
        transport: "webrtc",
        clientSecret: "secret",
      };
    });
    const onVideoCapability = vi.fn();
    const session = new RealtimeTalkSession({ request } as never, "main", {
      onVideoCapability,
    });

    await session.start();

    expect(request).toHaveBeenNthCalledWith(1, "talk.catalog", {});
    expect(request).toHaveBeenNthCalledWith(2, "talk.client.create", {
      sessionKey: "main",
      capabilities: ["camera-frame"],
    });
    expect(onVideoCapability).toHaveBeenCalledWith(true);
    expect(webRtcCtor).toHaveBeenCalledWith(
      expect.any(Object),
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
      return { provider: "openai", transport: "webrtc", clientSecret: "secret" };
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
        transport: "webrtc",
        clientSecret: "secret",
      };
    });
    const onVideoCapability = vi.fn();
    const session = new RealtimeTalkSession({ request } as never, "main", {
      onVideoCapability,
    });

    await session.start();

    expect(request).toHaveBeenNthCalledWith(2, "talk.client.create", { sessionKey: "main" });
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
      ["talk.client.create", { sessionKey: "main" }],
      ["talk.config", {}],
    ]);
    expect(relayCtor).not.toHaveBeenCalled();
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

    expect(request).toHaveBeenNthCalledWith(3, "talk.session.create", {
      sessionKey: "main",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
    });
    expect(relayCtor).toHaveBeenCalledTimes(1);
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

    expect(request).toHaveBeenNthCalledWith(3, "talk.session.create", {
      sessionKey: "main",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
    });
    expect(relayCtor).toHaveBeenCalledTimes(1);
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
      ["talk.client.create", { sessionKey: "main" }],
      ["talk.config", {}],
    ]);
    expect(relayCtor).not.toHaveBeenCalled();
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
      ["talk.client.create", { sessionKey: "main" }],
      ["talk.config", {}],
    ]);
    expect(relayCtor).not.toHaveBeenCalled();
  });
});
