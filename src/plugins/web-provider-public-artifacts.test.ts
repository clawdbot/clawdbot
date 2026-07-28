// Covers web provider public artifact extraction from plugin metadata.
import { describe, expect, it } from "vitest";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import {
  loadBundledWebFetchProviderEntriesFromDir,
  loadBundledWebSearchProviderEntriesFromDir,
} from "./web-provider-public-artifacts.explicit.js";

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
  it("declares bundled web providers in manifests", () => {
    expect(webSearchPluginIds).not.toHaveLength(0);
    expect(webFetchPluginIds).not.toHaveLength(0);
  });

  it.each(webSearchPluginIds)("loads public web-search artifacts for %s", (pluginId) => {
    expect(
      loadBundledWebSearchProviderEntriesFromDir({ dirName: pluginId, pluginId }),
    ).not.toBeNull();
  });

  it.each(webFetchPluginIds)("loads public web-fetch artifacts for %s", (pluginId) => {
    expect(
      loadBundledWebFetchProviderEntriesFromDir({ dirName: pluginId, pluginId }),
    ).not.toBeNull();
  });
});
