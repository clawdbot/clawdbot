// Defines normalized provider catalog results from plugin metadata.
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.js";
import {
  copyArrayEntries,
  copyRecordEntries,
  isRecordWithoutThrowing,
  readRecordValue,
} from "../shared/safe-record.js";
import type { ProviderCatalogOutcome, ProviderCatalogResult } from "./types.js";

const PROVIDER_CATALOG_OUTCOME_STATUSES = new Set<ProviderCatalogOutcome["status"]>([
  "ready",
  "auth-rejected",
  "unavailable",
]);

const MODEL_PROVIDER_CONFIG_KEYS = [
  "baseUrl",
  "apiKey",
  "auth",
  "api",
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

/** Projection of a provider catalog result into provider config entries. */
type ProviderCatalogResultProjection =
  | { kind: "provider"; provider: ModelProviderConfig }
  | { kind: "providers"; providers: Array<[string, ModelProviderConfig]> }
  | { kind: "empty" };

/** Copies provider config data out of a provider catalog result. */
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

/** Copies valid, secret-free provider outcomes out of a catalog hook result. */
export function copyProviderCatalogOutcomes(
  result: ProviderCatalogResult,
): ProviderCatalogOutcome[] {
  return copyArrayEntries(readRecordValue(result, "outcomes")).flatMap((entry) => {
    if (!isRecordWithoutThrowing(entry)) {
      return [];
    }
    const provider = readRecordValue(entry, "provider");
    const profileId = readRecordValue(entry, "profileId");
    const rejectionScope = readRecordValue(entry, "rejectionScope");
    const status = readRecordValue(entry, "status");
    if (
      typeof provider !== "string" ||
      provider.trim().length === 0 ||
      (profileId !== undefined &&
        (typeof profileId !== "string" || profileId.trim().length === 0)) ||
      (rejectionScope !== undefined && rejectionScope !== "catalog") ||
      typeof status !== "string" ||
      !PROVIDER_CATALOG_OUTCOME_STATUSES.has(status as ProviderCatalogOutcome["status"])
    ) {
      return [];
    }
    return [
      {
        provider: provider.trim(),
        ...(typeof profileId === "string" ? { profileId: profileId.trim() } : {}),
        ...(rejectionScope === "catalog" ? { rejectionScope } : {}),
        status: status as ProviderCatalogOutcome["status"],
      },
    ];
  });
}

/** Copies provider catalog result entries, using providerId for single-provider results. */
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

/** Copies model definitions from provider catalog provider config. */
function copyProviderCatalogModels(
  providerConfig: ModelProviderConfig,
): ModelProviderConfig["models"] {
  const models: ModelDefinitionConfig[] = [];
  for (const entry of copyArrayEntries(readRecordValue(providerConfig, "models"))) {
    const copied = copyProviderCatalogModel(entry);
    if (copied) {
      models.push(copied);
    }
  }
  return models;
}

function copyProviderCatalogModel(model: unknown): ModelDefinitionConfig | undefined {
  if (!isRecordWithoutThrowing(model)) {
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

/** Copies the supported provider config fields from a provider catalog result. */
function copyProviderCatalogProviderConfig(
  providerConfig: unknown,
): ModelProviderConfig | undefined {
  if (!isRecordWithoutThrowing(providerConfig)) {
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
