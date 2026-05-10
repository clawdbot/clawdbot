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
                voice: "alloy",
              },
            },
            instructions: "Speak with crisp diction.",
          },
        },
      }),
    ).not.toThrow();
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
