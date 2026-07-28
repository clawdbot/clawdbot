/** Pure repair rules for OpenClaw-generated plugin model catalogs. */

export const PLUGIN_MODEL_CATALOG_GENERATED_BY = "openclaw-plugin-model-catalog-v1";

type PluginModelCatalogRepair = {
  contents: string;
  removedModelCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCatalogApi(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function isGeneratedPluginModelCatalog(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.generatedBy === PLUGIN_MODEL_CATALOG_GENERATED_BY;
}

/** Removes model rows whose transport API cannot be derived without inventing semantics. */
export function repairPluginModelCatalogTransportMetadata(
  contents: string,
): PluginModelCatalogRepair {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    return { contents, removedModelCount: 0 };
  }
  if (!isGeneratedPluginModelCatalog(parsed) || !isRecord(parsed.providers)) {
    return { contents, removedModelCount: 0 };
  }

  let removedModelCount = 0;
  const providers: Record<string, unknown> = {};
  for (const [providerId, provider] of Object.entries(parsed.providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models) || hasCatalogApi(provider.api)) {
      providers[providerId] = provider;
      continue;
    }
    const models = provider.models.filter((model) => isRecord(model) && hasCatalogApi(model.api));
    removedModelCount += provider.models.length - models.length;
    providers[providerId] =
      models.length === provider.models.length ? provider : { ...provider, models };
  }
  if (removedModelCount === 0) {
    return { contents, removedModelCount };
  }
  const trailingNewline = contents.endsWith("\n") ? "\n" : "";
  return {
    contents: `${JSON.stringify({ ...parsed, providers }, null, 2)}${trailingNewline}`,
    removedModelCount,
  };
}
