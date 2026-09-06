// Media-understanding default model/provider selection from config, manifest
// metadata, and capability declarations.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  normalizeMediaExecutionProviderId,
  normalizeMediaProviderId,
} from "../../packages/media-understanding-common/src/provider-id.js";
import type { OpenClawConfig } from "../config/types.js";
import { buildMediaUnderstandingManifestMetadataRegistry } from "./manifest-metadata.js";
import {
  resolveAutoMediaKeyProvidersFromRegistry,
  resolveDefaultMediaModelFromRegistry,
} from "./provider-registry-metadata.js";
import type { MediaUnderstandingCapability, MediaUnderstandingProvider } from "./types.js";
export {
  CLI_OUTPUT_MAX_BUFFER,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_CHARS_BY_CAPABILITY,
  DEFAULT_MEDIA_CONCURRENCY,
  DEFAULT_PROMPT,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_VIDEO_MAX_BASE64_BYTES,
  MIN_AUDIO_FILE_BYTES,
} from "./defaults.constants.js";

function resolveConfiguredImageProviderModel(params: {
  cfg?: OpenClawConfig;
  providerId: string;
}): string | undefined {
  const normalizedProviderId = normalizeMediaProviderId(params.providerId);
  const providers = params.cfg?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return undefined;
  }
  for (const [providerKey, providerCfg] of Object.entries(providers)) {
    if (normalizeMediaProviderId(providerKey) !== normalizedProviderId) {
      continue;
    }
    const models = providerCfg?.models ?? [];
    const match = models.find(
      (model) =>
        Boolean(normalizeOptionalString(model?.id)) &&
        Array.isArray(model?.input) &&
        model.input.includes("image"),
    );
    return normalizeOptionalString(match?.id);
  }
  return undefined;
}

function resolveConfiguredImageProviderIds(cfg?: OpenClawConfig): string[] {
  const providers = cfg?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return [];
  }
  const configured: string[] = [];
  for (const [providerKey, providerCfg] of Object.entries(providers)) {
    const normalizedProviderId = normalizeMediaExecutionProviderId(providerKey);
    if (!normalizedProviderId || configured.includes(normalizedProviderId)) {
      continue;
    }
    const models = providerCfg?.models ?? [];
    const hasImageModel = models.some(
      (model) => Array.isArray(model?.input) && model.input.includes("image"),
    );
    if (hasImageModel) {
      configured.push(normalizedProviderId);
    }
  }
  return configured;
}

function isExecutionAliasProvider(providerId: string): boolean {
  return normalizeMediaProviderId(providerId) !== providerId;
}

function insertConfiguredImageProviders(params: {
  prioritized: string[];
  configured: string[];
}): string[] {
  const merged = [...params.prioritized];
  for (const providerId of params.configured.filter(isExecutionAliasProvider)) {
    const canonicalProviderId = normalizeMediaProviderId(providerId);
    const canonicalIndex = merged.indexOf(canonicalProviderId);
    if (canonicalIndex >= 0) {
      merged.splice(canonicalIndex, 0, providerId);
    } else {
      merged.unshift(providerId);
    }
  }
  for (const providerId of params.configured.filter((id) => !isExecutionAliasProvider(id))) {
    merged.push(providerId);
  }
  return uniqueStrings(merged);
}

/** Resolves the default provider model for a media capability from config or manifest metadata. */
export function resolveDefaultMediaModel(params: {
  providerId: string;
  capability: MediaUnderstandingCapability;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  providerRegistry?: Map<string, MediaUnderstandingProvider>;
  includeConfiguredImageModels?: boolean;
}): string | undefined {
  if (!params.providerRegistry && params.includeConfiguredImageModels !== false) {
    const configuredImageModel =
      params.capability === "image"
        ? resolveConfiguredImageProviderModel({
            cfg: params.cfg,
            providerId: params.providerId,
          })
        : undefined;
    if (configuredImageModel) {
      return configuredImageModel;
    }
  }
  const registry =
    params.providerRegistry ??
    buildMediaUnderstandingManifestMetadataRegistry(params.cfg, params.workspaceDir);
  return resolveDefaultMediaModelFromRegistry({
    providerId: params.providerId,
    capability: params.capability,
    providerRegistry: registry,
  });
}

/** Resolves auto-discovery provider order for a media capability using manifest priorities. */
export function resolveAutoMediaKeyProviders(params: {
  capability: MediaUnderstandingCapability;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  providerRegistry?: Map<string, MediaUnderstandingProvider>;
}): string[] {
  const registry =
    params.providerRegistry ??
    buildMediaUnderstandingManifestMetadataRegistry(params.cfg, params.workspaceDir);
  const prioritized = resolveAutoMediaKeyProvidersFromRegistry({
    capability: params.capability,
    providerRegistry: registry,
  });
  if (params.providerRegistry || params.capability !== "image") {
    return prioritized;
  }
  return insertConfiguredImageProviders({
    prioritized,
    configured: resolveConfiguredImageProviderIds(params.cfg),
  });
}

/** Returns whether provider metadata declares native PDF document input support. */
export function providerSupportsNativePdfDocument(params: {
  providerId: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  providerRegistry?: Map<string, MediaUnderstandingProvider>;
}): boolean {
  const registry =
    params.providerRegistry ??
    buildMediaUnderstandingManifestMetadataRegistry(params.cfg, params.workspaceDir);
  const provider = registry.get(normalizeMediaProviderId(params.providerId));
  return provider?.nativeDocumentInputs?.includes("pdf") ?? false;
}

/** Resolves provider-specific document model hints, preserving explicit unsupported markers. */
export function resolveDocumentMediaModel(params: {
  providerId: string;
  document: "pdf";
  mode: "textExtraction" | "image";
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  providerRegistry?: Map<string, MediaUnderstandingProvider>;
}): string | false | undefined {
  const registry =
    params.providerRegistry ??
    buildMediaUnderstandingManifestMetadataRegistry(params.cfg, params.workspaceDir);
  const provider = registry.get(normalizeMediaProviderId(params.providerId));
  const value = provider?.documentModels?.[params.document]?.[params.mode];
  if (value === false) {
    return false;
  }
  return normalizeOptionalString(value);
}
