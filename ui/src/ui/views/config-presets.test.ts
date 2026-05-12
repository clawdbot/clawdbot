import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "../../../../src/config/zod-schema.js";
import { CONFIG_PRESETS, detectActivePreset } from "./config-presets.ts";

describe("detectActivePreset", () => {
  it("keeps every preset patch valid for the runtime config schema", () => {
    expect(
      CONFIG_PRESETS.map((preset) => ({
        id: preset.id,
        defaults: preset.patch.agents.defaults,
      })),
    ).toStrictEqual([
      {
        id: "personal",
        defaults: {
          bootstrapMaxChars: 20_000,
          bootstrapTotalMaxChars: 150_000,
          contextInjection: "always",
        },
      },
      {
        id: "codeAgent",
        defaults: {
          bootstrapMaxChars: 50_000,
          bootstrapTotalMaxChars: 300_000,
          contextInjection: "always",
        },
      },
      {
        id: "teamBot",
        defaults: {
          bootstrapMaxChars: 10_000,
          bootstrapTotalMaxChars: 80_000,
          contextInjection: "continuation-skip",
        },
      },
      {
        id: "minimal",
        defaults: {
          bootstrapMaxChars: 5_000,
          bootstrapTotalMaxChars: 30_000,
          contextInjection: "continuation-skip",
        },
      },
    ]);

    for (const preset of CONFIG_PRESETS) {
      expect(OpenClawSchema.safeParse(preset.patch).success, preset.id).toBe(true);
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
