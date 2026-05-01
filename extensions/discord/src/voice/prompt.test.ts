import { describe, expect, it } from "vitest";
import { DISCORD_VOICE_SPOKEN_OUTPUT_CONTRACT, formatVoiceIngressPrompt } from "./prompt.js";

describe("formatVoiceIngressPrompt", () => {
  it("formats speaker-labeled voice input with the spoken-output contract", () => {
    expect(formatVoiceIngressPrompt("hello there", "speaker-1")).toBe(
      `${DISCORD_VOICE_SPOKEN_OUTPUT_CONTRACT}\n\nVoice transcript from speaker "speaker-1":\nhello there`,
    );
  });

  it("keeps unlabeled transcripts under the spoken-output contract", () => {
    expect(formatVoiceIngressPrompt("hello there")).toBe(
      `${DISCORD_VOICE_SPOKEN_OUTPUT_CONTRACT}\n\nhello there`,
    );
  });
});
