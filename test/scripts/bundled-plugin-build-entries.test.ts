import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectRootPackageExcludedExtensionDirs,
  listBundledPluginBuildEntries,
  listBundledPluginPackArtifacts,
} from "../../scripts/lib/bundled-plugin-build-entries.mjs";

describe("bundled plugin build entries", () => {
  const bundledChannelEntrySources = ["index.ts", "channel-entry.ts", "setup-entry.ts"];
  const forEachBundledChannelEntry = (
    visit: (params: { entryPath: string; entry: string; pluginId: string }) => void,
  ) => {
    for (const dirent of fs.readdirSync("extensions", { withFileTypes: true })) {
      if (!dirent.isDirectory()) {
        continue;
      }

      for (const sourceEntry of bundledChannelEntrySources) {
        const entryPath = path.join("extensions", dirent.name, sourceEntry);
        if (!fs.existsSync(entryPath)) {
          continue;
        }
        visit({
          entryPath,
          entry: fs.readFileSync(entryPath, "utf8"),
          pluginId: dirent.name,
        });
      }
    }
  };

  it("includes manifest-less runtime core support packages in dist build entries", () => {
    const entries = listBundledPluginBuildEntries();

    expect(entries).toMatchObject({
      "extensions/image-generation-core/api": "extensions/image-generation-core/api.ts",
      "extensions/image-generation-core/runtime-api":
        "extensions/image-generation-core/runtime-api.ts",
      "extensions/media-understanding-core/runtime-api":
        "extensions/media-understanding-core/runtime-api.ts",
      "extensions/speech-core/api": "extensions/speech-core/api.ts",
      "extensions/speech-core/runtime-api": "extensions/speech-core/runtime-api.ts",
    });
  });

  it("keeps the Matrix packaged runtime shim in bundled plugin build entries", () => {
    const entries = listBundledPluginBuildEntries();

    expect(entries).toMatchObject({
      "extensions/matrix/plugin-entry.handlers.runtime":
        "extensions/matrix/plugin-entry.handlers.runtime.ts",
    });
  });

  it("packs runtime core support packages without requiring plugin manifests", () => {
    const artifacts = listBundledPluginPackArtifacts();

    expect(artifacts).toContain("dist/extensions/image-generation-core/package.json");
    expect(artifacts).toContain("dist/extensions/image-generation-core/runtime-api.js");
    expect(artifacts).not.toContain("dist/extensions/image-generation-core/openclaw.plugin.json");
    expect(artifacts).toContain("dist/extensions/media-understanding-core/runtime-api.js");
    expect(artifacts).not.toContain(
      "dist/extensions/media-understanding-core/openclaw.plugin.json",
    );
    expect(artifacts).toContain("dist/extensions/speech-core/runtime-api.js");
    expect(artifacts).not.toContain("dist/extensions/speech-core/openclaw.plugin.json");
  });

  it("packs the Matrix packaged runtime shim", () => {
    const artifacts = listBundledPluginPackArtifacts({ includeRootPackageExcludedDirs: true });

    expect(artifacts).toContain("dist/extensions/matrix/plugin-entry.handlers.runtime.js");
  });

  it("keeps private QA bundles out of required npm pack artifacts", () => {
    const artifacts = listBundledPluginPackArtifacts();

    expect(artifacts.some((artifact) => artifact.startsWith("dist/extensions/qa-channel/"))).toBe(
      false,
    );
    expect(artifacts.some((artifact) => artifact.startsWith("dist/extensions/qa-lab/"))).toBe(
      false,
    );
    expect(artifacts.some((artifact) => artifact.startsWith("dist/extensions/qa-matrix/"))).toBe(
      false,
    );
  });

  it("keeps explicitly downloadable plugins out of bundled package artifacts", () => {
    const entries = listBundledPluginBuildEntries();
    const artifacts = listBundledPluginPackArtifacts();

    expect(Object.keys(entries).some((entry) => entry.startsWith("extensions/bluebubbles/"))).toBe(
      true,
    );
    expect(artifacts.some((artifact) => artifact.startsWith("dist/extensions/bluebubbles/"))).toBe(
      false,
    );
    for (const pluginId of ["acpx", "googlechat", "line"]) {
      expect(
        Object.keys(entries).some((entry) => entry.startsWith(`extensions/${pluginId}/`)),
      ).toBe(true);
      expect(
        artifacts.some((artifact) => artifact.startsWith(`dist/extensions/${pluginId}/`)),
      ).toBe(false);
    }
    expect(Object.keys(entries).some((entry) => entry.startsWith("extensions/qqbot/"))).toBe(false);
    expect(artifacts.some((artifact) => artifact.startsWith("dist/extensions/qqbot/"))).toBe(false);
  });

  it("keeps bundled channel secret contracts on packed top-level sidecars", () => {
    const artifacts = listBundledPluginPackArtifacts();
    const excludedPackageDirs = collectRootPackageExcludedExtensionDirs();
    const offenders: string[] = [];
    const secretBackedPluginIds = new Set<string>();

    forEachBundledChannelEntry(({ entryPath, entry, pluginId }) => {
      if (!entry.includes('exportName: "channelSecrets"')) {
        return;
      }
      secretBackedPluginIds.add(pluginId);
      if (entry.includes("./src/secret-contract.js")) {
        offenders.push(entryPath);
      }
      expect(entry).toContain('specifier: "./secret-contract-api.js"');
    });

    expect(offenders).toEqual([]);

    for (const pluginId of [...secretBackedPluginIds].toSorted()) {
      if (excludedPackageDirs.has(pluginId)) {
        continue;
      }
      const secretApiPath = path.join("extensions", pluginId, "secret-contract-api.ts");
      expect(fs.readFileSync(secretApiPath, "utf8")).toContain("channelSecrets");
      expect(artifacts).toContain(`dist/extensions/${pluginId}/secret-contract-api.js`);
    }
  });

  it("keeps bundled channel entry metadata on packed top-level sidecars", () => {
    const offenders: string[] = [];

    forEachBundledChannelEntry(({ entryPath, entry }) => {
      if (
        !entry.includes("defineBundledChannelEntry") &&
        !entry.includes("defineBundledChannelSetupEntry")
      ) {
        return;
      }
      if (/specifier:\s*["']\.\/src\//u.test(entry)) {
        offenders.push(entryPath);
      }
    });

    expect(offenders).toEqual([]);
  });
});
