import { describe, expect, it } from "vitest";
import { resolvePreferredTtsVoice } from "./tts-provider-voice.js";

describe("resolvePreferredTtsVoice", () => {
  it("returns provider voice when present", () => {
    expect(
      resolvePreferredTtsVoice({
        tts: {
          provider: "openai",
          providers: {
            openai: {
              voice: "coral",
            },
          },
        },
      }),
    ).toBe("coral");
  });

  it("falls back to voiceId for providers that use that field", () => {
    expect(
      resolvePreferredTtsVoice({
        tts: {
          provider: "elevenlabs",
          providers: {
            elevenlabs: {
              voiceId: "voice-123",
            },
          },
        },
      }),
    ).toBe("voice-123");
  });
});
