import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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

function listGitExtensionPackagePaths(extensionsDir: string): string[] | null {
  const relativeDir = path.relative(repoRoot, extensionsDir).split(path.sep).join("/");
  if (!relativeDir || relativeDir.startsWith("..") || path.isAbsolute(relativeDir)) {
    return null;
  }
  const result = spawnSync("git", ["ls-files", "--", relativeDir], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim().replaceAll("\\", "/"))
    .filter((line) => /^extensions\/[^/]+\/package\.json$/u.test(line))
    .map((line) => path.join(repoRoot, ...line.split("/")))
    .toSorted();
}

function listExtensionPackagePaths(extensionsDir: string): string[] {
  const gitPaths = listGitExtensionPackagePaths(extensionsDir);
  if (gitPaths) {
    return gitPaths;
  }

  return fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(extensionsDir, entry.name, "package.json"))
    .filter((packagePath) => fs.existsSync(packagePath));
}

function readManifestRecords(): PluginManifest[] {
  const extensionsDir = path.join(repoRoot, "extensions");
  return listExtensionPackagePaths(extensionsDir)
    .filter((packagePath) => {
      const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf-8")) as {
        openclaw?: OpenClawPackageManifest;
      };
      return normalizeBundledPluginStringList(packageJson.openclaw?.extensions).length > 0;
    })
    .map(
      (packagePath) =>
        JSON.parse(
          fs.readFileSync(path.join(path.dirname(packagePath), "openclaw.plugin.json"), "utf-8"),
        ) as PluginManifest,
    )
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

describe("bundled capability metadata", () => {
  it("lists bundled extension packages from git without scanning extension dirs", () => {
    const extensionsDir = path.join(repoRoot, "extensions");
    const readDir = vi.spyOn(fs, "readdirSync");
    try {
      const packagePaths = listExtensionPackagePaths(extensionsDir);

      expect(packagePaths.length).toBeGreaterThan(0);
      expect(packagePaths.every((file) => file.endsWith("package.json"))).toBe(true);
      expect(readDir).not.toHaveBeenCalled();
    } finally {
      readDir.mockRestore();
    }
  });

  it("keeps contract snapshots aligned with bundled plugin manifests", () => {
    const expected = readManifestRecords()
      .map(buildBundledPluginContractSnapshot)
      .filter(hasBundledPluginContractSnapshotCapabilities)
      .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));

    expect(BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS).toEqual(expected);
    expect(
      BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.find((entry) => entry.pluginId === "migrate-hermes"),
    ).toEqual({
      pluginId: "migrate-hermes",
      cliBackendIds: [],
      providerIds: [],
      providerAuthEnvVars: {},
      speechProviderIds: [],
      realtimeTranscriptionProviderIds: [],
      realtimeVoiceProviderIds: [],
      mediaUnderstandingProviderIds: [],
      documentExtractorIds: [],
      imageGenerationProviderIds: [],
      videoGenerationProviderIds: [],
      musicGenerationProviderIds: [],
      webContentExtractorIds: [],
      webFetchProviderIds: [],
      webSearchProviderIds: [],
      migrationProviderIds: ["hermes"],
      toolNames: [],
    });
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
