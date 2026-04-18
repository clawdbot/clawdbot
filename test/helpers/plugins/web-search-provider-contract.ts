import { describe, expect, it } from "vitest";
import {
  pluginRegistrationContractRegistry,
  resolveWebSearchProviderContractEntriesForPluginId,
} from "../../../src/plugins/contracts/registry.js";
import { resolveBundledExplicitWebSearchProvidersFromPublicArtifacts } from "../../../src/plugins/web-provider-public-artifacts.explicit.js";
import { installWebSearchProviderContractSuite } from "./provider-contract-suites.js";

type WebSearchContractEntry = ReturnType<
  typeof resolveWebSearchProviderContractEntriesForPluginId
>[number];

function resolveWebSearchCredentialValue(provider: {
  id: string;
  requiresCredential?: boolean;
  envVars: readonly string[];
}): unknown {
  if (provider.requiresCredential === false) {
    return `${provider.id}-no-key-needed`;
  }
  const envVar = provider.envVars.find((entry) => entry.trim().length > 0);
  if (!envVar) {
    return `${provider.id}-test`;
  }
  if (envVar === "OPENROUTER_API_KEY") {
    return "openrouter-test";
  }
  return envVar.toLowerCase().includes("api_key") ? `${provider.id}-test` : "sk-test";
}

export function describeWebSearchProviderContracts(pluginId: string) {
  const providerIds =
    pluginRegistrationContractRegistry.find((entry) => entry.pluginId === pluginId)
      ?.webSearchProviderIds ?? [];

  const resolveProviders = (): WebSearchContractEntry[] => {
    const publicArtifactProviders = resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({
      onlyPluginIds: [pluginId],
    });
    if (publicArtifactProviders) {
      return publicArtifactProviders.map((provider) => ({
        pluginId: provider.pluginId,
        provider,
        credentialValue: resolveWebSearchCredentialValue(provider),
      }));
    }
    return resolveWebSearchProviderContractEntriesForPluginId(pluginId);
  };

  describe(`${pluginId} web search provider contract registry load`, () => {
    it("loads bundled web search providers", () => {
      expect(resolveProviders().length).toBeGreaterThan(0);
    });
  });

  for (const providerId of providerIds) {
    describe(`${pluginId}:${providerId} web search contract`, () => {
      installWebSearchProviderContractSuite({
        provider: () => {
          const entry = resolveProviders().find((entry) => entry.provider.id === providerId);
          if (!entry) {
            throw new Error(
              `web search provider contract entry missing for ${pluginId}:${providerId}`,
            );
          }
          return entry.provider;
        },
        credentialValue: () => {
          const entry = resolveProviders().find((entry) => entry.provider.id === providerId);
          if (!entry) {
            throw new Error(
              `web search provider contract entry missing for ${pluginId}:${providerId}`,
            );
          }
          return entry.credentialValue;
        },
      });
    });
  }
}
