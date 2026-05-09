import { describe, expect, it } from "vitest";
import { TtsConfigSchema } from "./zod-schema.core.js";

describe("TtsConfigSchema openai speed and instructions", () => {
  it("accepts speed and instructions in openai section", () => {
    expect(
      TtsConfigSchema.safeParse({
        providers: {
          openai: {
            voice: "alloy",
            speed: 1.5,
            instructions: "Speak in a cheerful tone",
          },
        },
      }),
    ).toMatchObject({ success: true });
  });

  it("accepts openai extraBody objects for compatible TTS endpoints", () => {
    expect(
      TtsConfigSchema.safeParse({
        providers: {
          openai: {
            baseUrl: "http://localhost:8880/v1",
            model: "kokoro",
            voice: "em_alex",
            extraBody: {
              lang: "e",
              speed: 1.2,
            },
          },
        },
      }),
    ).toMatchObject({ success: true });
  });

  it("accepts out-of-range openai speed for provider passthrough", () => {
    expect(
      TtsConfigSchema.safeParse({
        providers: {
          openai: {
            speed: 5.0,
          },
        },
      }),
    ).toMatchObject({ success: true });
  });

  it("accepts openai speed below minimum for provider passthrough", () => {
    expect(
      TtsConfigSchema.safeParse({
        providers: {
          openai: {
            speed: 0.1,
          },
        },
      }),
    ).toMatchObject({ success: true });
  });

  it("accepts provider-specific persona bindings and structured prompt fields", () => {
    expect(
      TtsConfigSchema.safeParse({
        persona: "alfred",
        personas: {
          alfred: {
            label: "Alfred",
            description: "Dry, warm British butler narrator.",
            provider: "google",
            fallbackPolicy: "preserve-persona",
            prompt: {
              profile: "A brilliant British butler.",
              scene: "A quiet late-night study.",
              sampleContext: "The speaker is answering a trusted operator.",
              style: "Refined and lightly amused.",
              accent: "British English.",
              pacing: "Measured.",
              constraints: ["Do not read configuration values aloud."],
            },
            providers: {
              google: {
                model: "gemini-3.1-flash-tts-preview",
                voiceName: "Algieba",
                promptTemplate: "audio-profile-v1",
              },
              openai: {
                model: "gpt-4o-mini-tts",
                voice: "cedar",
                instructions: "Speak with dry warmth.",
              },
            },
          },
        },
      }),
    ).toMatchObject({ success: true });
  });

  it("rejects persona rewrite config until runtime behavior exists", () => {
    const result = TtsConfigSchema.safeParse({
      personas: {
        alfred: {
          rewrite: {
            enabled: true,
          },
        },
      },
    });

    expect(result).toMatchObject({ success: false });
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          keys: ["rewrite"],
          path: ["personas", "alfred"],
        }),
      );
    }
  });
});
