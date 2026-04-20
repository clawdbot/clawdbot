import { loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader.js";
import type { ProviderPlugin } from "./types.js";

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

function tryLoadProviderContractApi(pluginId: string): Record<string, unknown> | null {
  try {
    return loadBundledPluginPublicArtifactModuleSync<Record<string, unknown>>({
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
}

function collectProviderContractEntries(params: {
  pluginId: string;
  mod: Record<string, unknown>;
}): ProviderContractEntry[] {
  const providers: ProviderContractEntry[] = [];
  for (const [name, exported] of Object.entries(params.mod).toSorted(([left], [right]) =>
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
    const candidate = exported();
    if (isProviderPlugin(candidate)) {
      providers.push({ pluginId: params.pluginId, provider: candidate });
    }
  }
  return providers;
}

export function resolveBundledExplicitProviderContractsFromPublicArtifacts(params: {
  onlyPluginIds: readonly string[];
}): ProviderContractEntry[] | null {
  const providers: ProviderContractEntry[] = [];
  for (const pluginId of [...new Set(params.onlyPluginIds)].toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    const mod = tryLoadProviderContractApi(pluginId);
    if (!mod) {
      return null;
    }
    const entries = collectProviderContractEntries({ pluginId, mod });
    if (entries.length === 0) {
      return null;
    }
    providers.push(...entries);
  }
  return providers;
}
