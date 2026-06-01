import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.js";
import {
  copyArrayEntries,
  copyRecordEntries,
  isRecord,
  readRecordValue,
} from "../shared/safe-record.js";
import type { ProviderCatalogResult } from "./types.js";

const MODEL_PROVIDER_CONFIG_KEYS = [
  "baseUrl",
  "apiKey",
  "auth",
  "api",
  "contextWindow",
  "contextTokens",
  "maxTokens",
  "timeoutSeconds",
  "region",
  "injectNumCtxForOpenAICompat",
  "params",
  "agentRuntime",
  "localService",
  "headers",
  "authHeader",
  "request",
] as const satisfies readonly (keyof ModelProviderConfig)[];

const MODEL_DEFINITION_CONFIG_KEYS = [
  "api",
  "baseUrl",
  "reasoning",
  "input",
  "cost",
  "contextWindow",
  "contextTokens",
  "maxTokens",
  "thinkingLevelMap",
  "params",
  "agentRuntime",
  "headers",
  "compat",
  "mediaInput",
  "metadataSource",
] as const satisfies readonly (keyof ModelDefinitionConfig)[];

export type ProviderCatalogResultProjection =
  | { kind: "provider"; provider: ModelProviderConfig }
  | { kind: "providers"; providers: Array<[string, ModelProviderConfig]> }
  | { kind: "empty" };

export function copyProviderCatalogResultProjection(
  result: ProviderCatalogResult,
): ProviderCatalogResultProjection {
  const provider = copyProviderCatalogProviderConfig(readRecordValue(result, "provider"));
  if (provider) {
    return { kind: "provider", provider };
  }

  const providers = copyRecordEntries<ModelProviderConfig>(
    readRecordValue(result, "providers"),
  ).flatMap(([providerId, providerConfig]) => {
    const copied = copyProviderCatalogProviderConfig(providerConfig);
    return copied ? [[providerId, copied] as [string, ModelProviderConfig]] : [];
  });
  return providers.length > 0 ? { kind: "providers", providers } : { kind: "empty" };
}

export function copyProviderCatalogResultEntries(params: {
  providerId: string;
  result: ProviderCatalogResult;
}): Array<[string, ModelProviderConfig]> {
  const projection = copyProviderCatalogResultProjection(params.result);
  if (projection.kind === "provider") {
    return [[params.providerId, projection.provider]];
  }
  return projection.kind === "providers" ? projection.providers : [];
}

export function copyProviderCatalogModels(
  providerConfig: ModelProviderConfig,
): ModelProviderConfig["models"] {
  return copyArrayEntries(readRecordValue(providerConfig, "models")).flatMap((entry) => {
    const copied = copyProviderCatalogModel(entry);
    return copied ? [copied] : [];
  });
}

function copyProviderCatalogModel(model: unknown): ModelDefinitionConfig | undefined {
  if (!isRecord(model)) {
    return undefined;
  }
  const id = readRecordValue(model, "id");
  const name = readRecordValue(model, "name");
  if (typeof id !== "string") {
    return undefined;
  }

  const copied: Partial<ModelDefinitionConfig> = {
    id,
    name: typeof name === "string" ? name : id,
  };
  for (const key of MODEL_DEFINITION_CONFIG_KEYS) {
    const value = readRecordValue(model, key);
    if (value !== undefined) {
      (copied as Record<string, unknown>)[key] = value;
    }
  }
  return copied as ModelDefinitionConfig;
}

export function copyProviderCatalogProviderConfig(
  providerConfig: unknown,
): ModelProviderConfig | undefined {
  if (!isRecord(providerConfig)) {
    return undefined;
  }

  const baseUrl = readRecordValue(providerConfig, "baseUrl");
  if (typeof baseUrl !== "string") {
    return undefined;
  }

  const copied: Partial<ModelProviderConfig> = {
    baseUrl,
    models: copyProviderCatalogModels(providerConfig as ModelProviderConfig),
  };
  for (const key of MODEL_PROVIDER_CONFIG_KEYS) {
    if (key === "baseUrl") {
      continue;
    }
    const value = readRecordValue(providerConfig, key);
    if (value !== undefined) {
      (copied as Record<string, unknown>)[key] = value;
    }
  }
  return copied as ModelProviderConfig;
}
