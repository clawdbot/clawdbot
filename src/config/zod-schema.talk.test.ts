// Covers talk schema parsing and validation behavior.
import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema talk validation", () => {
  it("accepts a positive integer talk.silenceTimeoutMs", () => {
    const result = OpenClawSchema.safeParse({
      talk: {
        consultThinkingLevel: "low",
        consultFastMode: true,
        silenceTimeoutMs: 1500,
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects invalid talk.consultThinkingLevel", () => {
    expect(() =>
      OpenClawSchema.parse({
        talk: {
          consultThinkingLevel: "turbo",
        },
      }),
    ).toThrow(/consultThinkingLevel/i);
  });

  it("accepts additional realtime Talk instructions", () => {
    expect(() =>
      OpenClawSchema.parse({
        talk: {
          realtime: {
            provider: "openai",
            providers: {
              openai: {
                model: "gpt-realtime",
                speakerVoice: "alloy",
                speakerVoiceId: "voice-123",
              },
            },
            instructions: "Speak with crisp diction.",
            consultRouting: "force-agent-consult",
          },
        },
      }),
    ).not.toThrow();
  });

  it("accepts realtime Talk voice detection and reasoning defaults", () => {
    expect(() =>
      OpenClawSchema.parse({
        talk: {
          realtime: {
            vadThreshold: 0.45,
            silenceDurationMs: 650,
            prefixPaddingMs: 250,
            reasoningEffort: "low",
          },
        },
      }),
    ).not.toThrow();
  });

  it.each([
    ["VAD below zero", { vadThreshold: -0.1 }],
    ["VAD above one", { vadThreshold: 1.1 }],
    ["zero silence duration", { silenceDurationMs: 0 }],
    ["fractional silence duration", { silenceDurationMs: 1.5 }],
    ["negative prefix padding", { prefixPaddingMs: -1 }],
    ["fractional prefix padding", { prefixPaddingMs: 1.5 }],
    ["empty reasoning effort", { reasoningEffort: "" }],
  ])("rejects invalid realtime Talk %s", (_label, realtime) => {
    expect(() => OpenClawSchema.parse({ talk: { realtime } })).toThrow();
  });

  it("rejects invalid realtime Talk consult routing", () => {
    expect(() =>
      OpenClawSchema.parse({
        talk: {
          realtime: {
            consultRouting: "always",
          },
        },
      }),
    ).toThrow(/consultRouting/i);
  });

  it.each([
    ["boolean", true],
    ["string", "1500"],
    ["float", 1500.5],
  ])("rejects %s talk.silenceTimeoutMs", (_label, value) => {
    expect(() =>
      OpenClawSchema.parse({
        talk: {
          silenceTimeoutMs: value,
        },
      }),
    ).toThrow(/silenceTimeoutMs|number|integer/i);
  });

  it("rejects talk.provider when it does not match talk.providers", () => {
    expect(() =>
      OpenClawSchema.parse({
        talk: {
          provider: "acme",
          providers: {
            elevenlabs: {
              voiceId: "voice-123",
            },
          },
        },
      }),
    ).toThrow(/talk\.provider|talk\.providers|missing "acme"/i);
  });

  it.each(["constructor", "__proto__"])(
    "rejects inherited Object.prototype key %s as a Talk provider",
    (provider) => {
      const providers = { elevenlabs: { voiceId: "voice-123" } };

      expect(OpenClawSchema.safeParse({ talk: { provider, providers } }).success).toBe(false);
      expect(
        OpenClawSchema.safeParse({ talk: { realtime: { provider, providers } } }).success,
      ).toBe(false);
    },
  );

  it("rejects multi-provider talk config without talk.provider", () => {
    expect(() =>
      OpenClawSchema.parse({
        talk: {
          providers: {
            acme: {
              voiceId: "voice-acme",
            },
            elevenlabs: {
              voiceId: "voice-eleven",
            },
          },
        },
      }),
    ).toThrow(/talk\.provider|required/i);
  });
});
