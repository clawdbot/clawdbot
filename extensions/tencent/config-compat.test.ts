// Tencent tests cover config compatibility repair behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { migrateTencentTokenHubModelDefaults } from "./config-compat.js";

const TENCENT_TOKENHUB_HY3_MODEL_REF = "tencent-tokenhub/hy3";
const TENCENT_TOKENHUB_HY3_PREVIEW_MODEL_REF = "tencent-tokenhub/hy3-preview";
const TENCENT_TOKENHUB_HY4_PREVIEW_MODEL_REF = "tencent-tokenhub/hy4-preview";

const REPAIRED_ALLOWLIST_CHANGE =
  `Updated Tencent TokenHub agent model defaults to include ${TENCENT_TOKENHUB_HY4_PREVIEW_MODEL_REF}, ` +
  `${TENCENT_TOKENHUB_HY3_MODEL_REF}, ${TENCENT_TOKENHUB_HY3_PREVIEW_MODEL_REF}.`;

describe("Tencent config compatibility", () => {
  it("promotes hy4-preview to primary for old deprecated-preview defaults", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: TENCENT_TOKENHUB_HY3_PREVIEW_MODEL_REF,
            fallbacks: ["openai/gpt-5.5"],
          },
          models: {
            [TENCENT_TOKENHUB_HY3_PREVIEW_MODEL_REF]: {
              alias: "Preview",
            },
          },
        },
      },
    } as OpenClawConfig;

    const result = migrateTencentTokenHubModelDefaults(config);

    expect(result.changes).toEqual([
      REPAIRED_ALLOWLIST_CHANGE,
      `Changed Tencent TokenHub primary default from ${TENCENT_TOKENHUB_HY3_PREVIEW_MODEL_REF} to ${TENCENT_TOKENHUB_HY4_PREVIEW_MODEL_REF}.`,
    ]);
    expect(result.config.agents?.defaults?.model).toEqual({
      primary: TENCENT_TOKENHUB_HY4_PREVIEW_MODEL_REF,
      fallbacks: ["openai/gpt-5.5"],
    });
    expect(result.config.agents?.defaults?.models).toEqual({
      [TENCENT_TOKENHUB_HY3_PREVIEW_MODEL_REF]: {
        alias: "Preview",
      },
      [TENCENT_TOKENHUB_HY3_MODEL_REF]: {
        alias: "Hy3 (TokenHub)",
      },
      [TENCENT_TOKENHUB_HY4_PREVIEW_MODEL_REF]: {
        alias: "Hy4 preview (TokenHub)",
      },
    });
    expect(config.agents?.defaults?.models).not.toHaveProperty(
      TENCENT_TOKENHUB_HY4_PREVIEW_MODEL_REF,
    );
  });

  it("backfills the allowlist without touching a working hy3 primary", () => {
    // hy3 is GA while hy4-preview is a preview that also needs the API key's
    // allowed-model scope to cover hy4, so a live hy3 primary must survive the
    // migration untouched.
    const config = {
      agents: {
        defaults: {
          model: { primary: TENCENT_TOKENHUB_HY3_MODEL_REF },
          models: {
            [TENCENT_TOKENHUB_HY3_MODEL_REF]: {
              alias: "Hy3 (TokenHub)",
            },
            [TENCENT_TOKENHUB_HY3_PREVIEW_MODEL_REF]: {
              alias: "Hy3 preview (TokenHub)",
            },
          },
        },
      },
    } as OpenClawConfig;

    const result = migrateTencentTokenHubModelDefaults(config);

    expect(result.changes).toEqual([REPAIRED_ALLOWLIST_CHANGE]);
    expect(result.config.agents?.defaults?.model).toEqual({
      primary: TENCENT_TOKENHUB_HY3_MODEL_REF,
    });
    expect(result.config.agents?.defaults?.models).toEqual({
      [TENCENT_TOKENHUB_HY3_MODEL_REF]: {
        alias: "Hy3 (TokenHub)",
      },
      [TENCENT_TOKENHUB_HY3_PREVIEW_MODEL_REF]: {
        alias: "Hy3 preview (TokenHub)",
      },
      [TENCENT_TOKENHUB_HY4_PREVIEW_MODEL_REF]: {
        alias: "Hy4 preview (TokenHub)",
      },
    });
  });

  it("adds the remaining TokenHub models for hy3-only intermediate configs", () => {
    const config = {
      agents: {
        defaults: {
          model: TENCENT_TOKENHUB_HY3_MODEL_REF,
          models: {
            [TENCENT_TOKENHUB_HY3_MODEL_REF]: {},
          },
        },
      },
    } as OpenClawConfig;

    const result = migrateTencentTokenHubModelDefaults(config);

    expect(result.config.agents?.defaults?.model).toBe(TENCENT_TOKENHUB_HY3_MODEL_REF);
    expect(result.config.agents?.defaults?.models).toEqual({
      [TENCENT_TOKENHUB_HY3_MODEL_REF]: {
        alias: "Hy3 (TokenHub)",
      },
      [TENCENT_TOKENHUB_HY3_PREVIEW_MODEL_REF]: {
        alias: "Hy3 preview (TokenHub)",
      },
      [TENCENT_TOKENHUB_HY4_PREVIEW_MODEL_REF]: {
        alias: "Hy4 preview (TokenHub)",
      },
    });
  });

  it("repairs configs that only pinned hy4-preview", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: TENCENT_TOKENHUB_HY4_PREVIEW_MODEL_REF },
          models: {
            [TENCENT_TOKENHUB_HY4_PREVIEW_MODEL_REF]: {},
          },
        },
      },
    } as OpenClawConfig;

    const result = migrateTencentTokenHubModelDefaults(config);

    expect(result.changes).toEqual([REPAIRED_ALLOWLIST_CHANGE]);
    expect(result.config.agents?.defaults?.model).toEqual({
      primary: TENCENT_TOKENHUB_HY4_PREVIEW_MODEL_REF,
    });
    expect(result.config.agents?.defaults?.models).toEqual({
      [TENCENT_TOKENHUB_HY4_PREVIEW_MODEL_REF]: {
        alias: "Hy4 preview (TokenHub)",
      },
      [TENCENT_TOKENHUB_HY3_MODEL_REF]: {
        alias: "Hy3 (TokenHub)",
      },
      [TENCENT_TOKENHUB_HY3_PREVIEW_MODEL_REF]: {
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
          model: { primary: TENCENT_TOKENHUB_HY4_PREVIEW_MODEL_REF },
          models: {
            [TENCENT_TOKENHUB_HY4_PREVIEW_MODEL_REF]: {
              alias: "Hy4 preview (TokenHub)",
            },
            [TENCENT_TOKENHUB_HY3_MODEL_REF]: {
              alias: "Hy3 (TokenHub)",
            },
            [TENCENT_TOKENHUB_HY3_PREVIEW_MODEL_REF]: {
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
