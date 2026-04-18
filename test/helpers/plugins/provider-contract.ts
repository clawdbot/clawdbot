import { describe, expect, it } from "vitest";
import {
  pluginRegistrationContractRegistry,
  providerContractLoadError,
  resolveProviderContractProvidersForPluginIds,
} from "../../../src/plugins/contracts/registry.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../../../src/plugins/public-surface-loader.js";
import type { ProviderPlugin } from "../../../src/plugins/types.js";
import { installProviderPluginContractSuite } from "./provider-contract-suites.js";

type ProviderContractEntry = {
  pluginId: string;
  provider: ProviderPlugin;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProviderPlugin(value: unknown): value is ProviderPlugin {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    Array.isArray(value.auth)
  );
}

function resolveProviderContractProvidersFromPublicArtifact(
  pluginId: string,
): ProviderContractEntry[] | null {
  let mod: Record<string, unknown>;
  try {
    mod = loadBundledPluginPublicArtifactModuleSync<Record<string, unknown>>({
      dirName: pluginId,
      artifactBasename: "provider-contract-api.js",
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Unable to resolve bundled plugin public surface ")
    ) {
      return null;
    }
    throw error;
  }

  const providers: ProviderContractEntry[] = [];
  for (const [name, exported] of Object.entries(mod).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      typeof exported !== "function" ||
      exported.length !== 0 ||
      !name.startsWith("create") ||
      !name.endsWith("Provider")
    ) {
      continue;
    }
    const provider = exported();
    if (isProviderPlugin(provider)) {
      providers.push({ pluginId, provider });
    }
  }
  return providers.length > 0 ? providers : null;
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
