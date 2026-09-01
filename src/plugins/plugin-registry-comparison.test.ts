// Verifies plugin registry freshness and difference attribution normalization.
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import {
  diffPluginRegistryRecords,
  resolvePluginRegistryContent,
} from "./plugin-registry-comparison.js";

function createIndex(
  packageBuild?: InstalledPluginIndex["plugins"][number]["packageBuild"],
): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "policy",
    generatedAtMs: 1,
    installRecords: {},
    diagnostics: [],
    plugins: [
      {
        pluginId: "acpx",
        manifestPath: "/plugins/acpx/openclaw.plugin.json",
        manifestHash: "acpx-manifest-hash",
        ...(packageBuild ? { packageBuild } : {}),
        rootDir: "/plugins/acpx",
        origin: "global",
        enabled: true,
        startup: {
          sidecar: false,
          memory: false,
          agentHarnesses: [],
        },
        compat: [],
      },
    ],
  };
}

function contentMatches(persisted: InstalledPluginIndex, derived: InstalledPluginIndex): boolean {
  return isDeepStrictEqual(
    resolvePluginRegistryContent(persisted, false),
    resolvePluginRegistryContent(derived, false),
  );
}

describe("plugin registry comparison", () => {
  it("treats an omitted packageBuild and a build-only packageBuild as the same contract", () => {
    const persisted = createIndex();
    const derived = createIndex({ openclawVersion: "test" });

    expect(contentMatches(persisted, derived)).toBe(true);
    expect(diffPluginRegistryRecords(persisted, derived, false, new Map())).toEqual([]);
  });

  it("keeps a declared bundledDist distinct from an omitted packageBuild", () => {
    const persisted = createIndex();
    const derived = createIndex({ openclawVersion: "test", bundledDist: false });

    expect(contentMatches(persisted, derived)).toBe(false);
  });

  it("still reports drift and attributes the plugin when bundledDist changes", () => {
    const persisted = createIndex({ openclawVersion: "test", bundledDist: true });
    const derived = createIndex({ openclawVersion: "test", bundledDist: false });

    expect(contentMatches(persisted, derived)).toBe(false);
    expect(diffPluginRegistryRecords(persisted, derived, false, new Map())).toMatchObject([
      { pluginId: "acpx" },
    ]);
  });
});
