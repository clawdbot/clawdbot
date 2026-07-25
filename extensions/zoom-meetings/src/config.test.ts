import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it } from "vitest";
import {
  resolveZoomMeetingsConfig,
  resolveZoomMeetingsGatewayOperationTimeoutMs,
} from "./config.js";

describe("Zoom meetings config", () => {
  it("allows the live Zoom web client enough time to reach prejoin and in-call UI", () => {
    const config = resolveZoomMeetingsConfig({});
    expect(config.chrome.waitForInCallMs).toBe(60_000);
    expect(resolveZoomMeetingsGatewayOperationTimeoutMs(config)).toBe(150_000);
  });

  it("covers sequential browser launch and in-call waits", () => {
    expect(
      resolveZoomMeetingsGatewayOperationTimeoutMs(
        resolveZoomMeetingsConfig({
          chrome: { joinTimeoutMs: 120_000, waitForInCallMs: 40_000 },
        }),
      ),
    ).toBe(310_000);
  });

  it("builds matching SoX commands from the selected audio format", () => {
    const config = resolveZoomMeetingsConfig({ chrome: { audioBufferBytes: 2048 } });
    expect(config.chrome.audioInputCommand).toContain("sox");
    expect(config.chrome.audioInputCommand).toContain("2048");
    expect(config.chrome.audioOutputCommand).toContain("BlackHole 2ch");

    const g711 = resolveZoomMeetingsConfig({ chrome: { audioFormat: "g711-ulaw-8khz" } });
    expect(g711.chrome.audioInputCommand).toContain("BlackHole 2ch");
    expect(g711.chrome.audioOutputCommand).toContain("BlackHole 2ch");
    expect(g711.chrome.audioInputCommand).toContain("mu-law");
  });

  it("preserves explicit command overrides and realtime passthrough", () => {
    const config = resolveZoomMeetingsConfig({
      defaultMode: "bidi",
      chrome: { audioInputCommand: ["capture"], audioOutputCommand: ["play"] },
      chromeNode: { node: "mac-node" },
      realtime: {
        voiceProvider: "google",
        model: "voice-model",
        providers: { google: { apiKey: "ref" } },
      },
    });
    expect(config).toMatchObject({
      defaultMode: "bidi",
      chrome: { audioInputCommand: ["capture"], audioOutputCommand: ["play"] },
      chromeNode: { node: "mac-node" },
      realtime: {
        voiceProvider: "google",
        model: "voice-model",
        providers: { google: { apiKey: "ref" } },
      },
    });
  });

  it("caps timer values and gateway grace", () => {
    const config = resolveZoomMeetingsConfig({
      chrome: { joinTimeoutMs: Number.MAX_VALUE, waitForInCallMs: Number.MAX_VALUE },
    });
    expect(config.chrome.joinTimeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(config.chrome.waitForInCallMs).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveZoomMeetingsGatewayOperationTimeoutMs(config)).toBe(MAX_TIMER_TIMEOUT_MS);
  });
});
