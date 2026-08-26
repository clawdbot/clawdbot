// Voice Call tests cover timer delays plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it } from "vitest";
import { resolveVoiceCallSecondsTimerDelayMs } from "./timer-delays.js";

describe("voice-call timer delays", () => {
  it("caps second-based delays to timer-safe milliseconds", () => {
    expect(resolveVoiceCallSecondsTimerDelayMs(Number.MAX_VALUE)).toBe(MAX_TIMER_TIMEOUT_MS);
  });
});
