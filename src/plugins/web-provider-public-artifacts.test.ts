import { describe, expect, it } from "vitest";
import { resolveManifestContractPluginIds } from "./manifest-registry.js";
import {
  hasBundledWebFetchProviderPublicArtifact,
  hasBundledWebSearchProviderPublicArtifact,
} from "./web-provider-public-artifacts.explicit.js";

describe("web provider public artifacts", () => {
  it("has a public artifact for every bundled web search provider declared in manifests", () => {
    const pluginIds = resolveManifestContractPluginIds({
      contract: "webSearchProviders",
      origin: "bundled",
    });

    expect(pluginIds).not.toHaveLength(0);
    for (const pluginId of pluginIds) {
      expect(hasBundledWebSearchProviderPublicArtifact(pluginId)).toBe(true);
    }
  });

  it("has a public artifact for every bundled web fetch provider declared in manifests", () => {
    const pluginIds = resolveManifestContractPluginIds({
      contract: "webFetchProviders",
      origin: "bundled",
    });

    expect(pluginIds).not.toHaveLength(0);
    for (const pluginId of pluginIds) {
      expect(hasBundledWebFetchProviderPublicArtifact(pluginId)).toBe(true);
    }
  });
});
