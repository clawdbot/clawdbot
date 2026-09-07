/**
 * Cerebras model provider builder.
 */
import { normalizeOpenRouterModelPricing } from "openclaw/plugin-sdk/model-catalog-pricing";
import type { OpenAICompatibleModelDiscoveryOptions } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  asOptionalRecord,
  asPositiveSafeInteger,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };

function projectCerebrasModels(
  rows: readonly unknown[],
  fallback: ModelProviderConfig,
): ModelDefinitionConfig[] {
  const seeds = new Map(fallback.models.map((model) => [model.id, model]));
  const models = new Map<string, ModelDefinitionConfig>();
  for (const row of rows) {
    const record = asOptionalRecord(row);
    const id = normalizeOptionalString(record?.id);
    const limits = asOptionalRecord(record?.limits);
    const contextWindow = asPositiveSafeInteger(limits?.max_context_length);
    const maxTokens = asPositiveSafeInteger(limits?.max_completion_tokens);
    if (
      !record ||
      !id ||
      id.length > 512 ||
      /[\s\p{Cc}]/u.test(id) ||
      (record.object !== undefined && record.object !== "model") ||
      record.deprecated === true ||
      !contextWindow ||
      !maxTokens
    ) {
      continue;
    }
    const seed = seeds.get(id);
    const capabilities = asOptionalRecord(record.capabilities);
    // Native metadata owns prices and limits; only the seed supplies trusted transport settings.
    models.set(id, {
      ...seed,
      id,
      name: normalizeOptionalString(record.name) ?? id,
      reasoning: capabilities?.reasoning === true,
      input: capabilities?.vision === true ? ["text", "image"] : ["text"],
      contextWindow,
      maxTokens,
      cost: normalizeOpenRouterModelPricing(record.pricing) ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      compat: {
        ...seed?.compat,
        ...(typeof capabilities?.tools === "boolean" ? { supportsTools: capabilities.tools } : {}),
      },
    });
  }
  return [...models.values()].toSorted((left, right) => left.id.localeCompare(right.id));
}

export const CEREBRAS_MODEL_DISCOVERY: OpenAICompatibleModelDiscoveryOptions = {
  // Public metadata must not receive inference credentials or describe a custom proxy's catalog.
  endpointUrl: {
    url: "https://api.cerebras.ai/public/v1/models",
    requireBaseUrl: manifest.modelCatalog.providers.cerebras.baseUrl,
  },
  authentication: "none",
  projectRows: projectCerebrasModels,
};

/** Builds the Cerebras OpenAI-compatible model provider config. */
export function buildCerebrasProvider(): ModelProviderConfig {
  return buildManifestModelProviderConfig({
    providerId: "cerebras",
    catalog: manifest.modelCatalog.providers.cerebras,
  });
}
