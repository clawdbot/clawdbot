import type {
  UnifiedModelCatalogEntry,
  UnifiedModelCatalogKind,
  UnifiedModelCatalogSource,
} from "../model-catalog/types.js";

export type MediaGenerationCatalogKind = Exclude<UnifiedModelCatalogKind, "text">;

export type MediaGenerationCatalogSource = Extract<
  UnifiedModelCatalogSource,
  "static" | "live" | "cache" | "configured"
>;

export type MediaGenerationCatalogEntry<TCapabilities = unknown> =
  UnifiedModelCatalogEntry<TCapabilities> & {
    kind: MediaGenerationCatalogKind;
    source: MediaGenerationCatalogSource;
  };

export type MediaGenerationCatalogProvider<TCapabilities = unknown> = {
  id: string;
  aliases?: readonly string[];
  label?: string;
  defaultModel?: string;
  models?: readonly string[];
  capabilities: TCapabilities;
};

function uniqueModels(provider: { defaultModel?: string; models?: readonly string[] }): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const candidate of [provider.defaultModel, ...(provider.models ?? [])]) {
    const model = candidate?.trim();
    if (!model || seen.has(model)) {
      continue;
    }
    seen.add(model);
    models.push(model);
  }
  return models;
}

export function synthesizeMediaGenerationCatalogEntries<TCapabilities>(params: {
  kind: MediaGenerationCatalogKind;
  provider: MediaGenerationCatalogProvider<TCapabilities>;
  modes?: readonly string[];
}): Array<MediaGenerationCatalogEntry<TCapabilities>> {
  const models = uniqueModels(params.provider);
  return models.map((model) => {
    const entry: MediaGenerationCatalogEntry<TCapabilities> = {
      kind: params.kind,
      provider: params.provider.id,
      model,
      source: "static",
      capabilities: params.provider.capabilities,
    };
    if (params.provider.label) {
      entry.label = params.provider.label;
    }
    if (model === params.provider.defaultModel) {
      entry.default = true;
    }
    if (params.modes) {
      entry.modes = params.modes;
    }
    return entry;
  });
}

export function listMediaGenerationProviderModels(provider: {
  defaultModel?: string;
  models?: readonly string[];
}): string[] {
  return uniqueModels(provider);
}
