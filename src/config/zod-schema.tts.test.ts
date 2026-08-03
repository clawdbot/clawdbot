// Verifies text-to-speech schema parsing and defaults.
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
          speed: 5,
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
