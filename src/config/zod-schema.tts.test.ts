import { describe, expect, it } from "vitest";
import { TtsConfigSchema } from "./zod-schema.core.js";

describe("TtsConfigSchema openai speed and instructions", () => {
  it("accepts speed and instructions in openai section", () => {
    const result = TtsConfigSchema.safeParse({
      providers: {
        openai: {
          voice: "alloy",
          speed: 1.5,
          instructions: "Speak in a cheerful tone",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts openai extraBody objects for compatible TTS endpoints", () => {
    const result = TtsConfigSchema.safeParse({
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
    });
    expect(result.success).toBe(true);
  });

  it("accepts out-of-range openai speed for provider passthrough", () => {
    const result = TtsConfigSchema.safeParse({
      providers: {
        openai: {
          speed: 5.0,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts openai speed below minimum for provider passthrough", () => {
    const result = TtsConfigSchema.safeParse({
      providers: {
        openai: {
          speed: 0.1,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts provider-specific persona bindings and structured prompt fields", () => {
    const result = TtsConfigSchema.safeParse({
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
    });
    expect(result.success).toBe(true);
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

    expect(result.success).toBe(false);
    if (!result.success) {
      const rewriteIssue = result.error.issues.find(
        (issue) =>
          Array.isArray((issue as { keys?: unknown }).keys) &&
          (issue as { keys?: unknown[] }).keys?.[0] === "rewrite",
      );
      expect((rewriteIssue as { keys?: unknown[] } | undefined)?.keys).toEqual(["rewrite"]);
      expect(rewriteIssue?.path).toEqual(["personas", "alfred"]);
    }
  });
});
