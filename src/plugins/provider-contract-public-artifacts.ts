// Extracts provider contract public artifacts from plugin manifests.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { collectPublicArtifactFactories } from "./public-artifact-factories.js";
import { loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader.js";
import type { ProviderPlugin } from "./types.js";

type ProviderContractEntry = {
  pluginId: string;
  provider: ProviderPlugin;
};

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

export function resolveBundledExplicitProviderContractsFromPublicArtifacts(params: {
  onlyPluginIds: readonly string[];
}): ProviderContractEntry[] | null {
  const providers: ProviderContractEntry[] = [];
  for (const pluginId of sortUniqueStrings(params.onlyPluginIds)) {
    const mod = tryLoadProviderContractApi(pluginId);
    if (!mod) {
      return null;
    }
    const entries = collectPublicArtifactFactories({
      mod,
      suffix: "Provider",
      isArtifact: isProviderPlugin,
    });
    if (entries.length === 0) {
      return null;
    }
    providers.push(...entries.map((provider) => ({ pluginId, provider })));
  }
  return providers;
}
