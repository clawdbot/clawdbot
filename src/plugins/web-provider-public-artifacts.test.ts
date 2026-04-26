import { describe, expect, it } from "vitest";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import {
  hasBundledWebFetchProviderPublicArtifact,
  hasBundledWebSearchProviderPublicArtifact,
} from "./web-provider-public-artifacts.explicit.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function supportsSecretRefWebSearchApiKey(
  plugin: ReturnType<typeof loadPluginManifestRegistry>["plugins"][number],
): boolean {
  const configProperties = isRecord(plugin.configSchema?.["properties"])
    ? plugin.configSchema["properties"]
    : undefined;
  const webSearch = configProperties?.["webSearch"];
  if (!isRecord(webSearch)) {
    return false;
  }
  const properties = isRecord(webSearch["properties"]) ? webSearch["properties"] : undefined;
  const apiKey = properties?.["apiKey"];
  if (!isRecord(apiKey)) {
    return false;
  }
  const typeValue = apiKey["type"];
  return Array.isArray(typeValue) && typeValue.includes("object");
}

const registry = loadPluginManifestRegistry();
const webSearchPluginIds = bundledPluginIdsWithContract("webSearchProviders");
const webFetchPluginIds = bundledPluginIdsWithContract("webFetchProviders");

function bundledPluginIdsWithContract(
  contract: "webSearchProviders" | "webFetchProviders",
): string[] {
  return registry.plugins
    .filter(
      (plugin) => plugin.origin === "bundled" && (plugin.contracts?.[contract]?.length ?? 0) > 0,
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

describe("web provider public artifacts", () => {
  it("has public artifacts for every bundled web provider declared in manifests", () => {
    expect(webSearchPluginIds).not.toHaveLength(0);
    for (const pluginId of webSearchPluginIds) {
      expect(hasBundledWebSearchProviderPublicArtifact(pluginId)).toBe(true);
    }

    expect(webFetchPluginIds).not.toHaveLength(0);
    for (const pluginId of webFetchPluginIds) {
      expect(hasBundledWebFetchProviderPublicArtifact(pluginId)).toBe(true);
    }
  });

  it("registers compatibility runtime paths for bundled SecretRef-capable web search providers", () => {
    const expectedPluginIds = registry.plugins
      .filter(
        (plugin) =>
          plugin.origin === "bundled" &&
          (plugin.contracts?.webSearchProviders?.length ?? 0) > 0 &&
          supportsSecretRefWebSearchApiKey(plugin),
      )
      .map((plugin) => plugin.id)
      .toSorted((left, right) => left.localeCompare(right));

    expect(expectedPluginIds).not.toHaveLength(0);
    const actualPluginIds = registry.plugins
      .filter(
        (plugin) =>
          plugin.origin === "bundled" &&
          (plugin.contracts?.webSearchProviders?.length ?? 0) > 0 &&
          (plugin.configContracts?.compatibilityRuntimePaths ?? []).includes(
            "tools.web.search.apiKey",
          ),
      )
      .map((plugin) => plugin.id)
      .toSorted((left, right) => left.localeCompare(right));
    expect(actualPluginIds).toEqual(expectedPluginIds);
  });
});
