import { describe, expect, it } from "vitest";
import {
  pluginRegistrationContractRegistry,
  resolveWebFetchProviderContractEntriesForPluginId,
} from "../../../src/plugins/contracts/registry.js";
import type { WebFetchProviderPlugin } from "../../../src/plugins/types.js";
import { resolveBundledExplicitWebFetchProvidersFromPublicArtifacts } from "../../../src/plugins/web-provider-public-artifacts.explicit.js";
import { installWebFetchProviderContractSuite } from "./provider-contract-suites.js";

function resolveWebFetchCredentialValue(provider: WebFetchProviderPlugin): unknown {
  if (provider.requiresCredential === false) {
    return `${provider.id}-no-key-needed`;
  }
  const envVar = provider.envVars.find((entry) => entry.trim().length > 0);
  if (!envVar) {
    return `${provider.id}-test`;
  }
  return envVar.toLowerCase().includes("api_key") ? `${provider.id}-test` : "sk-test";
}

export function describeWebFetchProviderContracts(pluginId: string) {
  const providerIds =
    pluginRegistrationContractRegistry.find((entry) => entry.pluginId === pluginId)
      ?.webFetchProviderIds ?? [];

  const resolveProviders = () => {
    const publicArtifactProviders = resolveBundledExplicitWebFetchProvidersFromPublicArtifacts({
      onlyPluginIds: [pluginId],
    });
    if (publicArtifactProviders) {
      return publicArtifactProviders.map((provider) => ({
        pluginId: provider.pluginId,
        provider,
        credentialValue: resolveWebFetchCredentialValue(provider),
      }));
    }
    return resolveWebFetchProviderContractEntriesForPluginId(pluginId);
  };

  describe(`${pluginId} web fetch provider contract registry load`, () => {
    it("loads bundled web fetch providers", () => {
      expect(resolveProviders().length).toBeGreaterThan(0);
    });
  });

  for (const providerId of providerIds) {
    describe(`${pluginId}:${providerId} web fetch contract`, () => {
      installWebFetchProviderContractSuite({
        provider: () => {
          const entry = resolveProviders().find((provider) => provider.provider.id === providerId);
          if (!entry) {
            throw new Error(
              `web fetch provider contract entry missing for ${pluginId}:${providerId}`,
            );
          }
          return entry.provider;
        },
        credentialValue: () => {
          const entry = resolveProviders().find((provider) => provider.provider.id === providerId);
          if (!entry) {
            throw new Error(
              `web fetch provider contract entry missing for ${pluginId}:${providerId}`,
            );
          }
          return entry.credentialValue;
        },
        pluginId,
      });
    });
  }
}
