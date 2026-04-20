import { describe, expect, it } from "vitest";
import {
  pluginRegistrationContractRegistry,
  providerContractLoadError,
  resolveProviderContractProvidersForPluginIds,
} from "../../../src/plugins/contracts/registry.js";
import { resolveBundledExplicitProviderContractsFromPublicArtifacts } from "../../../src/plugins/provider-contract-public-artifacts.js";
import type { ProviderPlugin } from "../../../src/plugins/types.js";
import { installProviderPluginContractSuite } from "./provider-contract-suites.js";

type ProviderContractEntry = {
  pluginId: string;
  provider: ProviderPlugin;
};

function resolveProviderContractProvidersFromPublicArtifact(
  pluginId: string,
): ProviderContractEntry[] | null {
  return resolveBundledExplicitProviderContractsFromPublicArtifacts({ onlyPluginIds: [pluginId] });
}

export function describeProviderContracts(pluginId: string) {
  const providerIds =
    pluginRegistrationContractRegistry.find((entry) => entry.pluginId === pluginId)?.providerIds ??
    [];
  const resolveProviderEntries = (): ProviderContractEntry[] => {
    const publicArtifactProviders = resolveProviderContractProvidersFromPublicArtifact(pluginId);
    if (publicArtifactProviders) {
      return publicArtifactProviders;
    }
    return resolveProviderContractProvidersForPluginIds([pluginId]).map((provider) => ({
      pluginId,
      provider,
    }));
  };

  describe(`${pluginId} provider contract registry load`, () => {
    it("loads bundled providers without import-time registry failure", () => {
      const providers = resolveProviderEntries();
      expect(providerContractLoadError).toBeUndefined();
      expect(providers.length).toBeGreaterThan(0);
    });
  });

  for (const providerId of providerIds) {
    describe(`${pluginId}:${providerId} provider contract`, () => {
      // Resolve provider entries lazily so the non-isolated extension runner
      // does not race provider contract collection against other file imports.
      installProviderPluginContractSuite({
        provider: () => {
          const entry = resolveProviderEntries().find((entry) => entry.provider.id === providerId);
          if (!entry) {
            throw new Error(`provider contract entry missing for ${pluginId}:${providerId}`);
          }
          return entry.provider;
        },
      });
    });
  }
}
