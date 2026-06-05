// Check Deprecated Api Usage tests cover check deprecated api usage script behavior.
import { describe, expect, it } from "vitest";
import { buildDeprecatedPluginSdkModuleSpecifiers } from "../../scripts/lib/deprecated-plugin-sdk-usage.mjs";
import deprecatedPublicPluginSdkSubpaths from "../../scripts/lib/plugin-sdk-deprecated-public-subpaths.json" with { type: "json" };

describe("scripts/check-deprecated-api-usage", () => {
  it("bans every curated deprecated public plugin SDK subpath", () => {
    const specifiers = new Set(buildDeprecatedPluginSdkModuleSpecifiers());

    for (const subpath of deprecatedPublicPluginSdkSubpaths) {
      expect(specifiers.has(`openclaw/plugin-sdk/${subpath}`), subpath).toBe(true);
    }
  });

  it("keeps root and private compatibility aliases explicit", () => {
    expect(buildDeprecatedPluginSdkModuleSpecifiers()).toEqual(
      expect.arrayContaining([
        "openclaw/plugin-sdk",
        "openclaw/plugin-sdk/agent-dir-compat",
        "openclaw/plugin-sdk/test-utils",
      ]),
    );
  });
});
