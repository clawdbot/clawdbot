import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { ModelProviderConfig } from "../config/types.js";
import { copyRecordEntries } from "../shared/safe-record.js";
import type { ProviderCatalogContext, ProviderCatalogResult } from "./types.js";

function addApiKeyToProvider(
  provider: ModelProviderConfig,
  apiKey: string,
): (ModelProviderConfig & { apiKey: string }) | undefined {
  try {
    return { ...provider, apiKey };
  } catch {
    return undefined;
  }
}

export function findCatalogTemplate(params: {
  entries: ReadonlyArray<{ provider: string; id: string }>;
  providerId: string;
  templateIds: readonly string[];
}) {
  return params.templateIds
    .map((templateId) =>
      params.entries.find(
        (entry) =>
          normalizeProviderId(entry.provider) === normalizeProviderId(params.providerId) &&
          normalizeLowercaseStringOrEmpty(entry.id) === normalizeLowercaseStringOrEmpty(templateId),
      ),
    )
    .find((entry) => entry !== undefined);
}

export async function buildSingleProviderApiKeyCatalog(params: {
  ctx: ProviderCatalogContext;
  providerId: string;
  buildProvider: () => ModelProviderConfig | Promise<ModelProviderConfig>;
  allowExplicitBaseUrl?: boolean;
}): Promise<ProviderCatalogResult> {
  const providerId = normalizeProviderId(params.providerId);
  const apiKey = params.ctx.resolveProviderApiKey(providerId).apiKey;
  if (!apiKey) {
    return null;
  }

  const explicitProvider =
    params.allowExplicitBaseUrl && params.ctx.config.models?.providers
      ? Object.entries(params.ctx.config.models.providers).find(
          ([configuredProviderId]) => normalizeProviderId(configuredProviderId) === providerId,
        )?.[1]
      : undefined;
  const explicitBaseUrl = normalizeOptionalString(explicitProvider?.baseUrl) ?? "";

  return {
    provider: {
      ...(await params.buildProvider()),
      ...(explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {}),
      apiKey,
    },
  };
}

export async function buildPairedProviderApiKeyCatalog(params: {
  ctx: ProviderCatalogContext;
  providerId: string;
  buildProviders: () =>
    | Record<string, ModelProviderConfig>
    | Promise<Record<string, ModelProviderConfig>>;
}): Promise<ProviderCatalogResult> {
  const apiKey = params.ctx.resolveProviderApiKey(normalizeProviderId(params.providerId)).apiKey;
  if (!apiKey) {
    return null;
  }

  const providers = await params.buildProviders();
  return {
    providers: Object.fromEntries(
      copyRecordEntries<ModelProviderConfig>(providers).flatMap(([id, provider]) => {
        const providerWithApiKey = addApiKeyToProvider(provider, apiKey);
        return providerWithApiKey ? [[id, providerWithApiKey]] : [];
      }),
    ),
  };
}
