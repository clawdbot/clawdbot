import { afterEach, describe, expect, it, vi } from "vitest";
import { hasExpectedPluginUninstallConfigState } from "../../scripts/e2e/lib/plugin-uninstall-assertions.mjs";

describe("plugin uninstall assertions", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts an absent legacy plugin entry but rejects every present falsy residue", () => {
    vi.stubEnv("OPENCLAW_FROZEN_TARGET_PLUGIN_UNINSTALL_MODE", "legacy");

    expect(hasExpectedPluginUninstallConfigState({ plugins: { entries: {} } }, "fixture")).toBe(
      true,
    );
    for (const entry of [null, false, 0, ""]) {
      expect(
        hasExpectedPluginUninstallConfigState(
          { plugins: { entries: { fixture: entry } } },
          "fixture",
        ),
      ).toBe(false);
    }
  });
});
