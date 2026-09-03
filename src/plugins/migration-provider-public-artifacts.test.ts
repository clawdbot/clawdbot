import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { resolveBundledMigrationProviderPublicArtifacts } from "./migration-provider-public-artifacts.js";
import { resetPluginCache } from "./plugin-cache.js";

const tempDirs = createTempDirTracker();

afterEach(() => {
  resetPluginCache();
  tempDirs.cleanup();
});

function createPlugin(artifactSource?: string, id = "migration-owner"): PluginManifestRecord {
  const rootDir = tempDirs.make("openclaw-migration-provider-artifact-");
  fs.writeFileSync(path.join(rootDir, "package.json"), '{"type":"commonjs"}\n');
  if (artifactSource !== undefined) {
    fs.writeFileSync(path.join(rootDir, "migration-provider-api.js"), artifactSource);
  }
  return {
    id,
    origin: "bundled",
    rootDir,
    contracts: { migrationProviders: ["fixture"] },
  } as PluginManifestRecord;
}

describe("migration provider public artifacts", () => {
  it("loads a manifest-owned bundled migration provider", () => {
    const plugin = createPlugin(`module.exports = {
  buildMigrationProvider() {
    return { id: "fixture", label: "Fixture", plan() {}, apply() {} };
  },
};\n`);

    expect(
      resolveBundledMigrationProviderPublicArtifacts({ plugins: [plugin], providerId: "fixture" }),
    ).toEqual([
      {
        pluginId: "migration-owner",
        provider: expect.objectContaining({ id: "fixture", label: "Fixture" }),
      },
    ]);
  });

  it("returns no provider when the optional artifact is absent", () => {
    expect(
      resolveBundledMigrationProviderPublicArtifacts({
        plugins: [createPlugin()],
        providerId: "fixture",
      }),
    ).toEqual([]);
  });

  it("fails closed when an artifact omits its provider factory", () => {
    const plugin = createPlugin("module.exports = {};\n");

    expect(() =>
      resolveBundledMigrationProviderPublicArtifacts({ plugins: [plugin], providerId: "fixture" }),
    ).toThrow("buildMigrationProvider is required");
  });

  it("fails closed when an artifact returns an undeclared provider", () => {
    const plugin = createPlugin(`module.exports = {
  buildMigrationProvider() {
    return { id: "wrong", label: "Wrong", plan() {}, apply() {} };
  },
};\n`);

    expect(() =>
      resolveBundledMigrationProviderPublicArtifacts({ plugins: [plugin], providerId: "fixture" }),
    ).toThrow("returned an invalid migration provider");
  });

  it("fails closed when bundled artifacts claim the same provider", () => {
    const source = `module.exports = {
  buildMigrationProvider() {
    return { id: "fixture", label: "Fixture", plan() {}, apply() {} };
  },
};\n`;

    expect(() =>
      resolveBundledMigrationProviderPublicArtifacts({
        plugins: [createPlugin(source, "owner-a"), createPlugin(source, "owner-b")],
        providerId: "fixture",
      }),
    ).toThrow('Multiple bundled plugins declare migration provider "fixture": owner-a, owner-b.');
  });
});
