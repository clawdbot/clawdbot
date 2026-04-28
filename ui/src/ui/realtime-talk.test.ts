// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  googleStart,
  googleStop,
  relayStart,
  relayStop,
  webRtcStart,
  webRtcStop,
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
  googleCtor: vi.fn(function () {
    return { start: googleStart, stop: googleStop };
  }),
  relayCtor: vi.fn(function () {
    return { start: relayStart, stop: relayStop };
  }),
  webRtcCtor: vi.fn(function () {
    return { start: webRtcStart, stop: webRtcStop };
  }),
}));

vi.mock("./chat/realtime-talk-google-live.ts", () => ({
  GoogleLiveRealtimeTalkTransport: googleCtor,
}));

vi.mock("./chat/realtime-talk-gateway-relay.ts", () => ({
  GatewayRelayRealtimeTalkTransport: relayCtor,
}));

vi.mock("./chat/realtime-talk-webrtc.ts", () => ({
  WebRtcSdpRealtimeTalkTransport: webRtcCtor,
}));

import { RealtimeTalkSession } from "./chat/realtime-talk.ts";

describe("RealtimeTalkSession", () => {
  beforeEach(() => {
    googleStart.mockClear();
    googleStop.mockClear();
    relayStart.mockClear();
    relayStop.mockClear();
    webRtcStart.mockClear();
    webRtcStop.mockClear();
    googleCtor.mockClear();
    relayCtor.mockClear();
    webRtcCtor.mockClear();
  });

  it("starts the Google Live WebSocket transport from a generic session result", async () => {
    const request = vi.fn(async () => ({
      provider: "google",
      transport: "json-pcm-websocket",
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

    expect(request).toHaveBeenCalledWith("talk.realtime.session", { sessionKey: "main" });
    expect(googleCtor).toHaveBeenCalledTimes(1);
    expect(googleStart).toHaveBeenCalledTimes(1);
    expect(webRtcCtor).not.toHaveBeenCalled();
    expect(relayCtor).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith("connecting");
  });

  it("keeps Google Live WebSocket sessions off the WebRTC fallback when transport is omitted", async () => {
    const request = vi.fn(async () => ({
      provider: "google",
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
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();

    expect(googleCtor).toHaveBeenCalledTimes(1);
    expect(googleStart).toHaveBeenCalledTimes(1);
    expect(webRtcCtor).not.toHaveBeenCalled();
  });

  it("does not treat ambiguous Google sessions as browser WebRTC sessions", async () => {
    const request = vi.fn(async () => ({
      provider: "google",
      clientSecret: "secret",
    }));
    const session = new RealtimeTalkSession({ request } as never, "main");

    await expect(session.start()).rejects.toThrow(
      'Realtime voice provider "google" does not support browser WebRTC sessions. Control UI Talk can use Google through the gateway relay or a Google Live WebSocket session instead. Restart the gateway so it returns "gateway-relay" or "json-pcm-websocket", or switch Talk realtime to a WebRTC-capable provider such as OpenAI.',
    );

    expect(webRtcCtor).not.toHaveBeenCalled();
    expect(googleCtor).not.toHaveBeenCalled();
  });

  it("does not infer Google Live transport from websocketUrl on non-Google sessions", async () => {
    const request = vi.fn(async () => ({
      provider: "example",
      clientSecret: "secret",
      websocketUrl: "wss://example.test/live",
    }));
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();

    expect(webRtcCtor).toHaveBeenCalledTimes(1);
    expect(googleCtor).not.toHaveBeenCalled();
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

  it("keeps legacy session results on the OpenAI-style WebRTC transport", async () => {
    const request = vi.fn(async () => ({
      provider: "openai",
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
});
