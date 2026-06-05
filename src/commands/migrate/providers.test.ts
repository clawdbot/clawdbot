// Migration provider tests cover provider-specific option shaping.
import { describe, expect, it } from "vitest";
import { buildMigrationProviderOptions } from "./providers.js";

describe("buildMigrationProviderOptions", () => {
  it("uses the resolved provider id for Codex options", () => {
    expect(
      buildMigrationProviderOptions(
        {
          configPatchMode: "return",
          verifyPluginApps: true,
        },
        "codex",
      ),
    ).toEqual({
      configPatchMode: "return",
      verifyPluginApps: true,
    });
  });

  it("omits Codex-only options for other providers", () => {
    expect(
      buildMigrationProviderOptions(
        {
          configPatchMode: "return",
          provider: "other",
          verifyPluginApps: true,
        },
        "other",
      ),
    ).toBeUndefined();
  });
});
