import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "../../../../src/config/zod-schema.js";
import { CONFIG_PRESETS, detectActivePreset } from "./config-presets.ts";

describe("detectActivePreset", () => {
  it("keeps every preset patch valid for the runtime config schema", () => {
    for (const preset of CONFIG_PRESETS) {
      const defaults = preset.patch.agents.defaults;

      expect(() => OpenClawSchema.parse(preset.patch), preset.id).not.toThrow();
      expect(defaults.bootstrapMaxChars, preset.id).toBeGreaterThan(0);
      expect(defaults.bootstrapTotalMaxChars, preset.id).toBeGreaterThan(0);
      expect(defaults.bootstrapTotalMaxChars, preset.id).toBeGreaterThanOrEqual(
        defaults.bootstrapMaxChars,
      );
    }
  });

  it("returns null when bootstrap defaults are unset", () => {
    expect(detectActivePreset({})).toBeNull();
  });

  it("returns the matching preset when all preset fields match", () => {
    expect(
      detectActivePreset({
        agents: {
          defaults: {
            bootstrapMaxChars: 50_000,
            bootstrapTotalMaxChars: 300_000,
            contextInjection: "always",
          },
        },
      }),
    ).toBe("codeAgent");
  });

  it("does not match a preset when context injection differs", () => {
    expect(
      detectActivePreset({
        agents: {
          defaults: {
            bootstrapMaxChars: 50_000,
            bootstrapTotalMaxChars: 300_000,
            contextInjection: "continuation-skip",
          },
        },
      }),
    ).toBeNull();
  });
});
