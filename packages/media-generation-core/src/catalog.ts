// Media Generation Core module implements catalog behavior.
import { uniqueTrimmedStrings } from "./string.js";

// Shared media-generation catalog contracts and static entry synthesis.

/** Catalog kind for generated media model entries. */
export type MediaGenerationCatalogKind =
  | "image_generation"
  | "video_generation"
  | "music_generation";

/** Source for a media generation catalog entry. */
export type MediaGenerationCatalogSource = "static" | "live" | "cache" | "configured";

/** Media generation model catalog entry. */
export type MediaGenerationCatalogEntry<TCapabilities = unknown> = {
  kind: MediaGenerationCatalogKind;
  provider: string;
  model: string;
  label?: string;
  source: MediaGenerationCatalogSource;
  default?: boolean;
  configured?: boolean;
  capabilities?: TCapabilities;
  modes?: readonly string[];
  authEnvVars?: readonly string[];
  docsPath?: string;
  fetchedAt?: number;
  expiresAt?: number;
  warnings?: readonly string[];
};

/** Static catalog metadata that overrides provider defaults for one model. */
export type MediaGenerationCatalogModelEntry<TCapabilities = unknown> = {
  capabilities?: TCapabilities;
  modes?: readonly string[];
};

/** Provider metadata used to synthesize static media generation catalog entries. */
export type MediaGenerationCatalogProvider<TCapabilities = unknown> = {
  id: string;
  aliases?: readonly string[];
  label?: string;
  defaultModel?: string;
  models?: readonly string[];
  capabilities: TCapabilities;
  catalogByModel?: Readonly<Record<string, MediaGenerationCatalogModelEntry<TCapabilities>>>;
};

/** Return unique configured models with default model first when present. */
function uniqueModels(provider: { defaultModel?: string; models?: readonly string[] }): string[] {
  return uniqueTrimmedStrings([provider.defaultModel, ...(provider.models ?? [])]);
}

/** Synthesize static catalog entries from provider metadata. */
export function synthesizeMediaGenerationCatalogEntries<TCapabilities>(params: {
  kind: MediaGenerationCatalogKind;
  provider: MediaGenerationCatalogProvider<TCapabilities>;
  modes?: readonly string[];
}): Array<MediaGenerationCatalogEntry<TCapabilities>> {
  const defaultModel = uniqueTrimmedStrings([params.provider.defaultModel])[0];
  return uniqueModels(params.provider).map((model) => {
    const modelCatalogEntry = params.provider.catalogByModel?.[model];
    const entry: MediaGenerationCatalogEntry<TCapabilities> = {
      kind: params.kind,
      provider: params.provider.id,
      model,
      source: "static",
      capabilities: modelCatalogEntry?.capabilities ?? params.provider.capabilities,
    };
    if (params.provider.label) {
      entry.label = params.provider.label;
    }
    if (model === defaultModel) {
      entry.default = true;
    }
    const modes = modelCatalogEntry?.modes ?? params.modes;
    if (modes) {
      entry.modes = modes;
    }
    return entry;
  });
}

/** Return unique model ids exposed by a media generation provider. */
export function listMediaGenerationProviderModels(provider: {
  defaultModel?: string;
  models?: readonly string[];
}): string[] {
  return uniqueModels(provider);
}
