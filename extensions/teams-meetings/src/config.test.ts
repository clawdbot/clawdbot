import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it } from "vitest";
import {
  resolveTeamsMeetingsConfig,
  resolveTeamsMeetingsGatewayOperationTimeoutMs,
} from "./config.js";

describe("Microsoft Teams meetings config", () => {
  it("allows the live Teams web client enough time to reach prejoin and in-call UI", () => {
    expect(resolveTeamsMeetingsConfig({}).chrome.waitForInCallMs).toBe(60_000);
  });

  it("builds matching SoX commands from the selected audio format", () => {
    const config = resolveTeamsMeetingsConfig({ chrome: { audioBufferBytes: 2048 } });
    expect(config.chrome.audioInputCommand).toContain("sox");
    expect(config.chrome.audioInputCommand).toContain("2048");
    expect(config.chrome.audioOutputCommand).toContain("BlackHole 2ch");
  });

  it("preserves explicit command overrides and realtime passthrough", () => {
    const config = resolveTeamsMeetingsConfig({
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
    const config = resolveTeamsMeetingsConfig({
      chrome: { joinTimeoutMs: Number.MAX_VALUE, waitForInCallMs: Number.MAX_VALUE },
    });
    expect(config.chrome.joinTimeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(config.chrome.waitForInCallMs).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveTeamsMeetingsGatewayOperationTimeoutMs(config)).toBe(MAX_TIMER_TIMEOUT_MS);
  });
});
