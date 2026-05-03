import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeBundledPluginStringList } from "./bundled-plugin-scan.js";
import {
  BUNDLED_AUTO_ENABLE_PROVIDER_PLUGIN_IDS,
  BUNDLED_LEGACY_PLUGIN_ID_ALIASES,
  BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS,
  buildBundledPluginContractSnapshot,
  hasBundledPluginContractSnapshotCapabilities,
} from "./contracts/inventory/bundled-capability-metadata.js";
import { pluginTestRepoRoot as repoRoot } from "./generated-plugin-test-helpers.js";
import type { OpenClawPackageManifest } from "./manifest.js";
import type { PluginManifest } from "./manifest.js";

function readManifestRecords(): PluginManifest[] {
  const extensionsDir = path.join(repoRoot, "extensions");
  return fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(extensionsDir, entry.name))
    .filter((pluginDir) => {
      const packagePath = path.join(pluginDir, "package.json");
      if (!fs.existsSync(packagePath)) {
        return false;
      }
      const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf-8")) as {
        openclaw?: OpenClawPackageManifest;
      };
      return normalizeBundledPluginStringList(packageJson.openclaw?.extensions).length > 0;
    })
    .map(
      (pluginDir) =>
        JSON.parse(
          fs.readFileSync(path.join(pluginDir, "openclaw.plugin.json"), "utf-8"),
        ) as PluginManifest,
    )
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

describe("bundled capability metadata", () => {
  it("keeps contract snapshots aligned with bundled plugin manifests", () => {
    const expected = readManifestRecords()
      .map(buildBundledPluginContractSnapshot)
      .filter(hasBundledPluginContractSnapshotCapabilities)
      .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));

    expect(BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS).toEqual(expected);
    expect(BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "migrate-hermes",
          migrationProviderIds: ["hermes"],
        }),
      ]),
    );
  });

  it("keeps lightweight alias maps aligned with bundled plugin manifests", () => {
    const manifests = readManifestRecords();
    const expectedLegacyAliases = Object.fromEntries(
      manifests
        .flatMap((manifest) =>
          (manifest.legacyPluginIds ?? []).map((legacyPluginId) => [legacyPluginId, manifest.id]),
        )
        .toSorted(([left], [right]) => left.localeCompare(right)),
    );
    const expectedAutoEnableProviderPluginIds = Object.fromEntries(
      manifests
        .flatMap((manifest) =>
          (manifest.autoEnableWhenConfiguredProviders ?? []).map((providerId) => [
            providerId,
            manifest.id,
          ]),
        )
        .toSorted(([left], [right]) => left.localeCompare(right)),
    );

    expect(BUNDLED_LEGACY_PLUGIN_ID_ALIASES).toEqual(expectedLegacyAliases);
    expect(BUNDLED_AUTO_ENABLE_PROVIDER_PLUGIN_IDS).toEqual(expectedAutoEnableProviderPluginIds);
  });
});
