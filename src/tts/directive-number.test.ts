// TTS directive number tests cover parsing numeric speech directives.
import { describe, expect, it } from "vitest";
import { parseSpeechDirectiveNumberOverride } from "./directive-number.js";

const policy = {
  enabled: true,
  allowText: true,
  allowProvider: true,
  allowVoice: true,
  allowModelId: true,
  allowVoiceSettings: true,
  allowNormalization: true,
  allowSeed: true,
};

describe("parseSpeechDirectiveNumberOverride", () => {
  it("parses strict decimal directive numbers into overrides", () => {
    expect(
      parseSpeechDirectiveNumberOverride({
        ctx: { key: "speed", value: "1.25", policy },
        overrideKey: "speed",
        range: { min: 0.5, max: 2 },
        warning: (value) => `invalid speed ${value}`,
      }),
    ).toEqual({ handled: true, overrides: { speed: 1.25 } });
  });

  it("rejects non-decimal directive numbers", () => {
    expect(
      parseSpeechDirectiveNumberOverride({
        ctx: { key: "speed", value: "0x1", policy },
        overrideKey: "speed",
        range: { min: 0.5, max: 2 },
        warning: (value) => `invalid speed ${value}`,
      }),
    ).toEqual({ handled: true, warnings: ["invalid speed 0x1"] });
  });

  it("respects exclusive range bounds", () => {
    expect(
      parseSpeechDirectiveNumberOverride({
        ctx: { key: "temperature", value: "0", policy },
        overrideKey: "temperature",
        range: { min: 0, minExclusive: true, max: 2 },
        warning: (value) => `invalid temperature ${value}`,
      }),
    ).toEqual({ handled: true, warnings: ["invalid temperature 0"] });
  });

  it("suppresses settings when policy disallows voice settings", () => {
    expect(
      parseSpeechDirectiveNumberOverride({
        ctx: {
          key: "speed",
          value: "1",
          policy: { ...policy, allowVoiceSettings: false },
        },
        overrideKey: "speed",
        range: { min: 0.5, max: 2 },
        warning: (value) => `invalid speed ${value}`,
      }),
    ).toEqual({ handled: true });
  });
});
