import { describe, expect, it } from "vitest";
import {
  createAliasOnlyPresetAppliers,
  resolveAgentModelPrimaryValue,
  type OpenClawConfig,
} from "./provider-onboard.js";

describe("createAliasOnlyPresetAppliers", () => {
  const modelRef = "example/default";
  const appliers = createAliasOnlyPresetAppliers({ modelRef, alias: "Example" });

  it("adds only the alias entry in provider-only mode", () => {
    const cfg: OpenClawConfig = {
      models: { mode: "merge", providers: {} },
      agents: { defaults: { models: { "other/model": { alias: "Other" } } } },
    };

    const result = appliers.applyProviderConfig(cfg);

    expect(result.models).toBe(cfg.models);
    expect(result.agents?.defaults?.model).toBeUndefined();
    expect(result.agents?.defaults?.models).toEqual({
      "other/model": { alias: "Other" },
      [modelRef]: { alias: "Example" },
    });
  });

  it("preserves entry fields and alias while replacing the primary", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "old/model", fallbacks: ["fallback/model"] },
          models: { [modelRef]: { alias: "Custom", params: { temperature: 0.2 } } },
        },
      },
    };

    const result = appliers.applyConfig(cfg);

    expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.model)).toBe(modelRef);
    expect(result.agents?.defaults?.model).toEqual({
      primary: modelRef,
      fallbacks: ["fallback/model"],
    });
    expect(result.agents?.defaults?.models?.[modelRef]).toEqual({
      alias: "Custom",
      params: { temperature: 0.2 },
    });
  });
});
