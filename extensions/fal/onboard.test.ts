// Fal tests cover onboard plugin behavior.
import {
  type OpenClawConfig,
  resolveAgentModelPrimaryValue,
} from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { applyFalConfig } from "./onboard.js";

const emptyCfg: OpenClawConfig = {};

describe("applyFalConfig", () => {
  it("writes the default image model to mediaModels.image (the key the runtime reads)", () => {
    const result = applyFalConfig(emptyCfg);

    expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.mediaModels?.image)).toBe(
      "fal/fal-ai/flux/dev",
    );
    // The retired key must stay untouched: nothing in the runtime reads it.
    expect(result.agents?.defaults).not.toHaveProperty("imageGenerationModel");
  });

  it("does not overwrite an existing mediaModels.image default", () => {
    const cfg = {
      agents: {
        defaults: {
          mediaModels: { image: { primary: "other-provider/custom-model" } },
        },
      },
    } as OpenClawConfig;

    const result = applyFalConfig(cfg);

    expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.mediaModels?.image)).toBe(
      "other-provider/custom-model",
    );
  });
});
