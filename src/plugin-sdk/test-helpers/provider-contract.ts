import { describe, expect, it } from "vitest";
import {
  providerContractLoadError,
  resolveProviderContractProvidersForPluginIds,
} from "../../plugins/contracts/registry.js";
import { resolveBundledExplicitProviderContractsFromPublicArtifacts } from "../../plugins/provider-contract-public-artifacts.js";
import type { ProviderPlugin } from "../provider-model-shared.js";
import { installProviderPluginContractSuite } from "./provider-contract-suites.js";

type ProviderContractEntry = {
  pluginId: string;
  provider: ProviderPlugin;
};

function providerMatchesManifestId(provider: ProviderPlugin, providerId: string): boolean {
  return (
    provider.id === providerId ||
    (provider.aliases ?? []).includes(providerId) ||
    (provider.hookAliases ?? []).includes(providerId)
  );
}
function resolveProviderContractProvidersFromPublicArtifact(
  pluginId: string,
): ProviderContractEntry[] | null {
  return resolveBundledExplicitProviderContractsFromPublicArtifacts({ onlyPluginIds: [pluginId] });
}

export function describeProviderContracts(pluginId: string) {
  let providerEntries: ProviderContractEntry[] | undefined;
  const resolveProviderEntries = (): ProviderContractEntry[] => {
    if (providerEntries) {
      return providerEntries;
    }
    const publicArtifactProviders = resolveProviderContractProvidersFromPublicArtifact(pluginId);
    if (publicArtifactProviders) {
      providerEntries = publicArtifactProviders;
      return providerEntries;
    }
    providerEntries = resolveProviderContractProvidersForPluginIds([pluginId]).map((provider) => ({
      pluginId,
      provider,
    }));
    return providerEntries;
  };
  const resolveProviderIds = (): string[] =>
    resolveProviderEntries().map((entry) => entry.provider.id);

  describe(`${pluginId} provider contract registry load`, () => {
    it("loads bundled providers without import-time registry failure", () => {
      const providers = resolveProviderEntries();
      expect(providerContractLoadError).toBeUndefined();
      expect(providers.length).toBeGreaterThan(0);
    });
  });

  for (const providerId of resolveProviderIds()) {
    describe(`${pluginId}:${providerId} provider contract`, () => {
      // Resolve provider entries lazily so the non-isolated extension runner
      // does not race provider contract collection against other file imports.
      installProviderPluginContractSuite({
        provider: () => {
          const entry = resolveProviderEntries().find((entry) =>
            providerMatchesManifestId(entry.provider, providerId),
          );
          if (!entry) {
            throw new Error(`provider contract entry missing for ${pluginId}:${providerId}`);
          }
          return entry.provider;
        },
      });
    });
  }
}
