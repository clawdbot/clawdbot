import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { applyFalConfig, FAL_DEFAULT_IMAGE_MODEL_REF } from "./onboard.js";

describe("applyFalConfig", () => {
  it("adds the canonical image default without replacing sibling media defaults", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          mediaModels: {
            video: { primary: "video/model" },
            music: { primary: "music/model" },
          },
        },
        entries: { main: { default: true } },
      },
    };

    const result = applyFalConfig(config);

    expect(result.agents?.defaults?.mediaModels).toEqual({
      image: { primary: FAL_DEFAULT_IMAGE_MODEL_REF },
      video: { primary: "video/model" },
      music: { primary: "music/model" },
    });
    expect(result.agents?.defaults).not.toHaveProperty("imageGenerationModel");
  });

  it("preserves an explicit canonical image default", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          mediaModels: { image: { primary: "custom/image" } },
        },
        entries: { main: { default: true } },
      },
    };

    expect(applyFalConfig(config)).toBe(config);
  });
});
