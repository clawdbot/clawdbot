import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it } from "vitest";
import { resolveGoogleMeetConfig, resolveGoogleMeetGatewayOperationTimeoutMs } from "./config.js";

describe("google meet gateway operation timeout", () => {
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
