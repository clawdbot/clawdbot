import type {
  UnifiedModelCatalogEntry,
  UnifiedModelCatalogKind,
  UnifiedModelCatalogSource,
} from "../model-catalog/types.js";
import { normalizeUniqueSingleOrTrimmedStringList } from "../shared/string-normalization.js";

export type MediaGenerationCatalogKind = Extract<
  UnifiedModelCatalogKind,
  "image_generation" | "video_generation" | "music_generation"
>;

export type MediaGenerationCatalogSource = Extract<
  UnifiedModelCatalogSource,
  "static" | "live" | "cache" | "configured"
>;

export type MediaGenerationCatalogEntry<TCapabilities> = UnifiedModelCatalogEntry<TCapabilities> & {
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
  return normalizeUniqueSingleOrTrimmedStringList([
    provider.defaultModel,
    ...(provider.models ?? []),
  ]);
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
