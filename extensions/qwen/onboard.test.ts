import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import {
  applyQwenConfig,
  applyQwenConfigCn,
  applyQwenStandardConfig,
  applyQwenStandardConfigCn,
  applyQwenTokenPlanConfig,
} from "./onboard.js";

describe.each([
  { name: "coding global", provider: "qwen", apply: applyQwenConfig, rows: 10 },
  { name: "coding China", provider: "qwen", apply: applyQwenConfigCn, rows: 10 },
  { name: "standard global", provider: "qwen", apply: applyQwenStandardConfig, rows: 14 },
  { name: "standard China", provider: "qwen", apply: applyQwenStandardConfigCn, rows: 14 },
  {
    name: "Token Plan global",
    provider: "qwen-token-plan",
    apply: (cfg: OpenClawConfig) => applyQwenTokenPlanConfig(cfg, "global"),
    rows: 8,
  },
  {
    name: "Token Plan China",
    provider: "qwen-token-plan",
    apply: (cfg: OpenClawConfig) => applyQwenTokenPlanConfig(cfg, "cn"),
    rows: 8,
  },
])("Qwen $name setup", ({ provider, apply, rows }) => {
  it.each([undefined, "merge"] as const)(
    "leaves ordinary %s rows runtime-owned and retains aliases",
    (mode) => {
      const input: OpenClawConfig = {
        models: { mode },
        agents: {
          defaults: {
            models: { "qwen/qwen3.5-plus": { alias: "Authored", params: { temperature: 0.2 } } },
          },
        },
      };
      const config = apply(input);

      expect(config.models?.providers?.[provider]?.models).toEqual([]);
      expect(config.agents?.defaults?.models?.["qwen/qwen3.5-plus"]).toEqual(
        input.agents?.defaults?.models?.["qwen/qwen3.5-plus"],
      );
      expect(config.agents?.defaults?.models?.[`${provider}/qwen3.7-plus`]).toBeDefined();
      if (provider === "qwen") {
        expect(config.agents?.defaults?.models?.["modelstudio/qwen3.7-plus"]).toBeDefined();
      }
      expect(apply(config)).toEqual(config);
    },
  );

  it("retains the shipped replace catalog", () => {
    const config = apply({ models: { mode: "replace" } });
    expect(config.models?.providers?.[provider]?.models).toHaveLength(rows);
  });
});
