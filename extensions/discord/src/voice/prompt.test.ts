import { describe, expect, it } from "vitest";
import { formatVoiceIngressPrompt } from "./prompt.js";

describe("formatVoiceIngressPrompt", () => {
  it("formats speaker-labeled voice input without imperative-looking prefixes", () => {
    expect(formatVoiceIngressPrompt("hello there", "speaker-1")).toBe(
      'Voice transcript from speaker "speaker-1":\nhello there',
    );
  });

  it("returns the bare transcript when no speaker label exists", () => {
    expect(formatVoiceIngressPrompt("hello there")).toBe("hello there");
  });
});
