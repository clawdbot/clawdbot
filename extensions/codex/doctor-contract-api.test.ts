import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

describe("codex doctor contract", () => {
  it("reports the retired dynamic tools profile config key", () => {
    expect(
      legacyConfigRules[0]?.match({
        codexDynamicToolsProfile: "openclaw-compat",
        codexDynamicToolsLoading: "direct",
      }),
    ).toBe(true);
    expect(legacyConfigRules[0]?.match({ codexDynamicToolsLoading: "direct" })).toBe(false);
  });

  it("removes the retired dynamic tools profile without dropping other Codex config", () => {
    const original = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              codexDynamicToolsProfile: "openclaw-compat",
              codexDynamicToolsLoading: "direct",
              codexDynamicToolsExclude: ["custom_tool"],
              appServer: { mode: "guardian" },
            },
          },
        },
      },
    };

    const result = normalizeCompatibilityConfig({ cfg: original });

    expect(result.changes).toEqual([
      "Removed retired plugins.entries.codex.config.codexDynamicToolsProfile; Codex app-server always keeps Codex-native workspace tools native.",
    ]);
    expect(result.config.plugins?.entries?.codex?.config).toEqual({
      codexDynamicToolsLoading: "direct",
      codexDynamicToolsExclude: ["custom_tool"],
      appServer: { mode: "guardian" },
    });
    expect(original.plugins.entries.codex.config).toHaveProperty("codexDynamicToolsProfile");
  });
});
