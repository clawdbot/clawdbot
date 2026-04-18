import { describe, expect, it } from "vitest";
import {
  resolveManifestContractOwnerPluginId,
  resolveManifestContractPluginIds,
} from "./manifest-registry.js";
import {
  hasBundledWebFetchProviderPublicArtifact,
  hasBundledWebSearchProviderPublicArtifact,
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
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

  it("keeps public web search artifacts mapped to their manifest owner plugin", () => {
    const pluginIds = resolveManifestContractPluginIds({
      contract: "webSearchProviders",
      origin: "bundled",
    });

    const providers = resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({
      onlyPluginIds: pluginIds,
    });

    expect(providers).not.toBeNull();
    for (const provider of providers ?? []) {
      expect(
        resolveManifestContractOwnerPluginId({
          contract: "webSearchProviders",
          value: provider.id,
          origin: "bundled",
        }),
      ).toBe(provider.pluginId);
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
