import { describe, expect, it } from "vitest";
import { TtsConfigSchema } from "./zod-schema.core.js";

describe("TtsConfigSchema openai speed and instructions", () => {
  it("accepts speed and instructions in openai section", () => {
    expect(() =>
      TtsConfigSchema.parse({
        providers: {
          openai: {
            voice: "alloy",
            speed: 1.5,
            instructions: "Speak in a cheerful tone",
          },
        },
      }),
    ).not.toThrow();
  });

  it("rejects out-of-range openai speed", () => {
    expect(() =>
      TtsConfigSchema.parse({
        providers: {
          openai: {
            speed: 5.0,
          },
        },
      }),
    ).not.toThrow();
  });

  it("rejects openai speed below minimum", () => {
    expect(() =>
      TtsConfigSchema.parse({
        providers: {
          openai: {
            speed: 0.1,
          },
        },
      }),
    ).not.toThrow();
  });

  it("accepts provider-specific persona bindings and structured prompt fields", () => {
    expect(() =>
      TtsConfigSchema.parse({
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
    ).not.toThrow();
  });

  it("rejects persona rewrite config until runtime behavior exists", () => {
    expect(() =>
      TtsConfigSchema.parse({
        personas: {
          alfred: {
            rewrite: {
              enabled: true,
            },
          },
        },
      }),
    ).toThrow();
  });
});
