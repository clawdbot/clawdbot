// Tencent tests cover config compatibility repair behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { migrateTencentTokenHubModelDefaults } from "./config-compat.js";

const TENCENT_TOKENHUB_DEFAULT_MODEL_REF = "tencent-tokenhub/hy3";
const TENCENT_TOKENHUB_PREVIEW_MODEL_REF = "tencent-tokenhub/hy3-preview";

describe("Tencent config compatibility", () => {
  it("adds the stable TokenHub model and makes it primary for old preview defaults", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: TENCENT_TOKENHUB_PREVIEW_MODEL_REF,
            fallbacks: ["openai/gpt-5.5"],
          },
          models: {
            [TENCENT_TOKENHUB_PREVIEW_MODEL_REF]: {
              alias: "Preview",
            },
          },
        },
      },
    } as OpenClawConfig;

    const result = migrateTencentTokenHubModelDefaults(config);

    expect(result.changes).toEqual([
      `Updated Tencent TokenHub agent model defaults to include ${TENCENT_TOKENHUB_DEFAULT_MODEL_REF} and ${TENCENT_TOKENHUB_PREVIEW_MODEL_REF}.`,
      `Changed Tencent TokenHub primary default from ${TENCENT_TOKENHUB_PREVIEW_MODEL_REF} to ${TENCENT_TOKENHUB_DEFAULT_MODEL_REF}.`,
    ]);
    expect(result.config.agents?.defaults?.model).toEqual({
      primary: TENCENT_TOKENHUB_DEFAULT_MODEL_REF,
      fallbacks: ["openai/gpt-5.5"],
    });
    expect(result.config.agents?.defaults?.models).toEqual({
      [TENCENT_TOKENHUB_PREVIEW_MODEL_REF]: {
        alias: "Preview",
      },
      [TENCENT_TOKENHUB_DEFAULT_MODEL_REF]: {
        alias: "Hy3 (TokenHub)",
      },
    });
    expect(config.agents?.defaults?.models).not.toHaveProperty(TENCENT_TOKENHUB_DEFAULT_MODEL_REF);
  });

  it("adds the preview TokenHub model for hy3-only intermediate configs", () => {
    const config = {
      agents: {
        defaults: {
          model: TENCENT_TOKENHUB_DEFAULT_MODEL_REF,
          models: {
            [TENCENT_TOKENHUB_DEFAULT_MODEL_REF]: {},
          },
        },
      },
    } as OpenClawConfig;

    const result = migrateTencentTokenHubModelDefaults(config);

    expect(result.config.agents?.defaults?.model).toBe(TENCENT_TOKENHUB_DEFAULT_MODEL_REF);
    expect(result.config.agents?.defaults?.models).toEqual({
      [TENCENT_TOKENHUB_DEFAULT_MODEL_REF]: {
        alias: "Hy3 (TokenHub)",
      },
      [TENCENT_TOKENHUB_PREVIEW_MODEL_REF]: {
        alias: "Hy3 preview (TokenHub)",
      },
    });
  });

  it("does not create a model allowlist when TokenHub models are not already configured", () => {
    const config = {
      models: {
        providers: {
          "tencent-tokenhub": {
            baseUrl: "https://tokenhub.tencentmaas.com/v1",
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    const result = migrateTencentTokenHubModelDefaults(config);

    expect(result).toEqual({ config, changes: [] });
  });

  it("does not report changes after TokenHub defaults are already repaired", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: TENCENT_TOKENHUB_DEFAULT_MODEL_REF },
          models: {
            [TENCENT_TOKENHUB_DEFAULT_MODEL_REF]: {
              alias: "Hy3 (TokenHub)",
            },
            [TENCENT_TOKENHUB_PREVIEW_MODEL_REF]: {
              alias: "Hy3 preview (TokenHub)",
            },
          },
        },
      },
    } as OpenClawConfig;

    const result = migrateTencentTokenHubModelDefaults(config);

    expect(result).toEqual({ config, changes: [] });
  });
});
