import { describe, expect, it } from "vitest";
import { resolvePreferredTtsVoice } from "./tts-provider-voice.js";

describe("resolvePreferredTtsVoice", () => {
  it("returns provider speakerVoice when present", () => {
    expect(
      resolvePreferredTtsVoice({
        tts: {
          provider: "openai",
          providers: {
            openai: {
              speakerVoice: "coral",
            },
          },
        },
      }),
    ).toBe("coral");
  });

  it("returns provider speakerVoiceId when present", () => {
    expect(
      resolvePreferredTtsVoice({
        tts: {
          provider: "elevenlabs",
          providers: {
            elevenlabs: {
              speakerVoiceId: "voice-123",
            },
          },
        },
      }),
    ).toBe("voice-123");
  });

  it("keeps legacy voice and voiceId fallback compatibility", () => {
    expect(
      resolvePreferredTtsVoice({
        tts: {
          provider: "openai",
          providers: {
            openai: {
              voice: "legacy-voice",
              voiceId: "legacy-id",
            },
          },
        },
      }),
    ).toBe("legacy-voice");
  });
});
