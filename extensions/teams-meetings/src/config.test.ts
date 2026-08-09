import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it } from "vitest";
import { teamsMeetingsConfig } from "./config.js";

const resolveTeamsMeetingsConfig = teamsMeetingsConfig.resolveConfig;
const resolveTeamsMeetingsGatewayOperationTimeoutMs =
  teamsMeetingsConfig.resolveGatewayOperationTimeoutMs;

describe("Microsoft Teams meetings config", () => {
  it("keeps sparse and legacy audio config compatible", () => {
    const sparse = resolveTeamsMeetingsConfig({});
    expect(sparse.chrome.audioBackend).toBe("auto");
    expect(sparse.chrome.audioInputCommandOverride).toBeUndefined();
    expect(sparse.chrome.audioOutputCommandOverride).toBeUndefined();

    const legacy = resolveTeamsMeetingsConfig({
      chrome: { audioBackend: "blackhole-2ch" },
    });
    expect(legacy.chrome.audioBackend).toBe("blackhole-2ch");
    expect(legacy.chrome.audioInputCommand).toContain("BlackHole 2ch");
    expect(legacy.chrome.audioOutputCommand).toContain("BlackHole 2ch");
  });

  it("allows the live Teams web client enough time to reach prejoin and in-call UI", () => {
    expect(resolveTeamsMeetingsConfig({}).chrome.waitForInCallMs).toBe(60_000);
  });

  it("builds native command pairs for the selected audio backend", () => {
    const config = resolveTeamsMeetingsConfig({
      chrome: { audioBackend: "blackhole-2ch", audioBufferBytes: 2048 },
    });
    expect(config.chrome.audioInputCommand).toContain("sox");
    expect(config.chrome.audioInputCommand).toContain("2048");
    expect(config.chrome.audioOutputCommand).toContain("BlackHole 2ch");

    const linux = resolveTeamsMeetingsConfig({
      chrome: { audioBackend: "pipewire-pulse", audioBufferBytes: 2_048 },
    });
    expect(linux.chrome.audioInputCommand).toContain("parec");
    expect(linux.chrome.audioOutputCommand).toContain("pacat");
    expect(linux.chrome.audioInputCommand).toContain("--latency-msec=43");
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
      chrome: {
        audioInputCommand: ["capture"],
        audioOutputCommand: ["play"],
        audioInputCommandOverride: ["capture"],
        audioOutputCommandOverride: ["play"],
      },
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
