// Voice Call tests cover timer delays plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it } from "vitest";
import {
  resolveVoiceCallSecondsTimerDelayMs,
  resolveVoiceCallTimerDelayMs,
} from "./timer-delays.js";

describe("voice-call timer delays", () => {
  it("caps second-based delays to timer-safe milliseconds", () => {
    expect(resolveVoiceCallSecondsTimerDelayMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveVoiceCallSecondsTimerDelayMs(Number.MAX_VALUE)).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("caps millisecond delays to timer-safe values", () => {
    expect(resolveVoiceCallTimerDelayMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMER_TIMEOUT_MS);
  });
});
