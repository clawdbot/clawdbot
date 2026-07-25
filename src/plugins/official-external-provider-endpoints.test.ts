// Guards the catalog mirror of externalized provider plugin endpoint metadata.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import rootPackageJson from "../../package.json" with { type: "json" };
import officialExternalProviderCatalog from "../../scripts/lib/official-external-provider-catalog.json" with { type: "json" };
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { listOfficialExternalProviderEndpointManifests } from "./official-external-provider-endpoints.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

type ExtensionManifestRecord = {
  dirName: string;
  manifest: Record<string, unknown>;
};

function listExtensionManifests(): ExtensionManifestRecord[] {
  const extensionsDir = path.join(repoRoot, "extensions");
  const records: ExtensionManifestRecord[] = [];
  for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = path.join(extensionsDir, entry.name, "openclaw.plugin.json");
    if (!fs.existsSync(manifestPath)) {
      continue;
    }
    const manifest = parseJsonWithJson5Fallback(fs.readFileSync(manifestPath, "utf8"));
    if (isRecord(manifest)) {
      records.push({ dirName: entry.name, manifest });
    }
  }
  return records;
}

// Dist packaging is what makes these plugins invisible to bundled discovery,
// so the package excludes are the source of truth for which manifests must be
// mirrored into the catalog.
const distExcludedExtensionDirs = new Set(
  (rootPackageJson.files ?? []).flatMap((entry) => {
    const match = /^!dist\/extensions\/([^/*]+)\/\*\*$/.exec(entry);
    return match?.[1] ? [match[1]] : [];
  }),
);

function listCatalogManifestsByPluginId(): Map<string, Record<string, unknown>> {
  const byPluginId = new Map<string, Record<string, unknown>>();
  for (const entry of officialExternalProviderCatalog.entries) {
    if (!isRecord(entry)) {
      continue;
    }
    const manifest = entry.openclaw;
    if (!isRecord(manifest) || !isRecord(manifest.plugin)) {
      continue;
    }
    const pluginId = manifest.plugin.id;
    if (typeof pluginId === "string" && pluginId.trim()) {
      byPluginId.set(pluginId, manifest);
    }
  }
  return byPluginId;
}

describe("official external provider endpoint catalog mirror", () => {
  const extensionManifests = listExtensionManifests();
  const catalogManifestsByPluginId = listCatalogManifestsByPluginId();

  it("mirrors providerEndpoints for every dist-excluded plugin manifest that declares them", () => {
    const checkedPluginIds: string[] = [];
    for (const { dirName, manifest } of extensionManifests) {
      if (!Array.isArray(manifest.providerEndpoints)) {
        continue;
      }
      if (!distExcludedExtensionDirs.has(dirName)) {
        continue;
      }
      const pluginId = typeof manifest.id === "string" ? manifest.id : undefined;
      const catalogManifest = pluginId ? catalogManifestsByPluginId.get(pluginId) : undefined;
      expect(
        catalogManifest,
        `extensions/${dirName} is excluded from dist and declares providerEndpoints; ` +
          `official-external-provider-catalog.json needs an entry for plugin "${pluginId}" ` +
          `mirroring them, or endpoint classification breaks when the plugin is not installed`,
      ).toBeDefined();
      expect(
        catalogManifest?.providerEndpoints,
        `catalog providerEndpoints for plugin "${pluginId}" must mirror extensions/${dirName}/openclaw.plugin.json`,
      ).toEqual(manifest.providerEndpoints);
      if (pluginId) {
        checkedPluginIds.push(pluginId);
      }
    }
    // The mirror set going empty means the scan above stopped covering the
    // externalized providers this contract exists for.
    expect(checkedPluginIds).toContain("qwen");
    expect(checkedPluginIds).toContain("moonshot");
  });

  it("keeps catalog providerEndpoints in sync with local plugin manifests", () => {
    const extensionManifestsById = new Map(
      extensionManifests
        .filter((record) => typeof record.manifest.id === "string")
        .map((record) => [record.manifest.id as string, record]),
    );
    for (const [pluginId, catalogManifest] of catalogManifestsByPluginId) {
      if (catalogManifest.providerEndpoints === undefined) {
        continue;
      }
      const local = extensionManifestsById.get(pluginId);
      if (!local) {
        // Catalog-only plugins have no in-repo manifest to compare against.
        continue;
      }
      expect(
        catalogManifest.providerEndpoints,
        `catalog providerEndpoints for plugin "${pluginId}" must mirror extensions/${local.dirName}/openclaw.plugin.json`,
      ).toEqual(local.manifest.providerEndpoints);
    }
  });

  it("exposes endpoint metadata for externalized providers", () => {
    const endpointClasses = listOfficialExternalProviderEndpointManifests().flatMap((manifest) =>
      Array.isArray(manifest.providerEndpoints)
        ? manifest.providerEndpoints.flatMap((endpoint) =>
            isRecord(endpoint) && typeof endpoint.endpointClass === "string"
              ? [endpoint.endpointClass]
              : [],
          )
        : [],
    );
    expect(endpointClasses).toContain("modelstudio-native");
    expect(endpointClasses).toContain("moonshot-native");
    expect(endpointClasses).toContain("meta-native");
    expect(endpointClasses).toContain("zai-native");
  });
});
