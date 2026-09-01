import { describe, expect, it } from "vitest";
import type { InstalledPluginIndexRecord } from "./installed-plugin-index-types.js";
import type { InstalledPluginIndex } from "./installed-plugin-index-types.js";
import { resolvePluginRegistryContent } from "./plugin-registry-comparison.js";
import { createInstalledPluginIndexSnapshot } from "./status.test-fixtures.js";

function makePluginRecord(
  overrides: Partial<InstalledPluginIndexRecord> = {},
): InstalledPluginIndexRecord {
  return {
    pluginId: "demo",
    source: "/plugins/demo",
    manifestPath: "/plugins/demo/openclaw.plugin.json",
    manifestHash: "manifest-hash",
    rootDir: "/plugins/demo",
    origin: "bundled",
    enabled: true,
    startup: { sidecar: false, memory: false, agentHarnesses: [] },
    compat: [],
    ...overrides,
  };
}

function makeIndex(plugins: InstalledPluginIndexRecord[]): InstalledPluginIndex {
  return createInstalledPluginIndexSnapshot(plugins) as InstalledPluginIndex;
}

describe("resolvePluginRegistryContent packageBuild normalization", () => {
  it("treats omitted packageBuild the same as packageBuild without bundledDist", () => {
    const omitted = resolvePluginRegistryContent(makeIndex([makePluginRecord()]), false) as {
      plugins: unknown[];
    };
    const buildOnly = resolvePluginRegistryContent(
      makeIndex([
        makePluginRecord({
          packageBuild: { openclawVersion: "2026.8.1" },
        }),
      ]),
      false,
    ) as { plugins: unknown[] };

    expect(buildOnly).toEqual(omitted);
  });

  it("preserves bundledDist when present", () => {
    const content = resolvePluginRegistryContent(
      makeIndex([
        makePluginRecord({
          packageBuild: { bundledDist: false, openclawVersion: "2026.8.1" },
        }),
      ]),
      false,
    ) as { plugins: Array<{ packageBuild?: { bundledDist: boolean } }> };

    expect(content.plugins[0]?.packageBuild).toEqual({ bundledDist: false });
  });
});
