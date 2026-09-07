// Google Meet tests cover config plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it } from "vitest";
import { resolveGoogleMeetConfig, resolveGoogleMeetGatewayOperationTimeoutMs } from "./config.js";

describe("google meet gateway operation timeout", () => {
  it("keeps sparse and legacy audio config compatible", () => {
    const sparse = resolveGoogleMeetConfig({});
    expect(sparse.chrome.audioBackend).toBe("auto");
    expect(sparse.chrome.audioInputCommandOverride).toBeUndefined();
    expect(sparse.chrome.audioOutputCommandOverride).toBeUndefined();

    const legacy = resolveGoogleMeetConfig({
      chrome: { audioBackend: "blackhole-2ch" },
    });
    expect(legacy.chrome.audioBackend).toBe("blackhole-2ch");
    expect(legacy.chrome.audioInputCommand).toContain("BlackHole 2ch");
    expect(legacy.chrome.audioOutputCommand).toContain("BlackHole 2ch");
  });

  it("builds PipeWire-Pulse commands and retains explicit overrides", () => {
    const linux = resolveGoogleMeetConfig({
      chrome: { audioBackend: "pipewire-pulse" },
    });
    expect(linux.chrome.audioInputCommand).toContain("parec");
    expect(linux.chrome.audioOutputCommand).toContain("pacat");

    const custom = resolveGoogleMeetConfig({
      chrome: { audioInputCommand: ["capture"], audioOutputCommand: ["play"] },
    });
    expect(custom.chrome).toMatchObject({
      audioInputCommand: ["capture"],
      audioOutputCommand: ["play"],
      audioInputCommandOverride: ["capture"],
      audioOutputCommandOverride: ["play"],
    });
  });

  it("caps timer config fields before runtime polling uses them", () => {
    const config = resolveGoogleMeetConfig({
      chrome: {
        joinTimeoutMs: Number.MAX_VALUE,
        waitForInCallMs: Number.MAX_VALUE,
        bargeInCooldownMs: Number.MAX_VALUE,
      },
      voiceCall: {
        requestTimeoutMs: Number.MAX_VALUE,
        dtmfDelayMs: Number.MAX_VALUE,
        postDtmfSpeechDelayMs: Number.MAX_VALUE,
      },
    });

    expect(config.chrome.joinTimeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(config.chrome.waitForInCallMs).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(config.chrome.bargeInCooldownMs).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(config.voiceCall.requestTimeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(config.voiceCall.dtmfDelayMs).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(config.voiceCall.postDtmfSpeechDelayMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("adds operation grace to normal transport timeouts", () => {
    expect(resolveGoogleMeetGatewayOperationTimeoutMs(resolveGoogleMeetConfig({}))).toBe(60_000);
    expect(
      resolveGoogleMeetGatewayOperationTimeoutMs(
        resolveGoogleMeetConfig({
          chrome: { joinTimeoutMs: 120_000 },
          voiceCall: { requestTimeoutMs: 30_000 },
        }),
      ),
    ).toBe(150_000);
  });

  it("caps overflowed transport timeout grace", () => {
    expect(
      resolveGoogleMeetGatewayOperationTimeoutMs(
        resolveGoogleMeetConfig({
          chrome: { joinTimeoutMs: Number.MAX_VALUE },
        }),
      ),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(
      resolveGoogleMeetGatewayOperationTimeoutMs(
        resolveGoogleMeetConfig({
          voiceCall: { requestTimeoutMs: Number.MAX_VALUE },
        }),
      ),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
  });
});
