import { MODEL_APIS, type ModelApi, type ModelCompatConfig } from "../config/types.models.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeTrimmedStringList } from "../shared/string-normalization.js";
import { isRecord } from "../utils.js";
import {
  buildModelCatalogMergeKey,
  buildModelCatalogRef,
  normalizeModelCatalogProviderId,
} from "./refs.js";
import type {
  ModelCatalog,
  ModelCatalogAlias,
  ModelCatalogCost,
  ModelCatalogDiscovery,
  ModelCatalogInput,
  ModelCatalogModel,
  ModelCatalogProvider,
  ModelCatalogSource,
  ModelCatalogStatus,
  ModelCatalogSuppression,
  ModelCatalogTieredCost,
  NormalizedModelCatalogRow,
} from "./types.js";

const MODEL_CATALOG_INPUTS = new Set(["text", "image", "document"]);
const MODEL_CATALOG_DISCOVERY_MODES = new Set(["static", "refreshable", "runtime"]);
const MODEL_CATALOG_STATUSES = new Set(["available", "preview", "deprecated", "disabled"]);
const MODEL_CATALOG_APIS = new Set<string>(MODEL_APIS);
const DEFAULT_MODEL_INPUT: ModelCatalogInput[] = ["text"];
const DEFAULT_MODEL_STATUS: ModelCatalogStatus = "available";

function normalizeSafeRecordKey(value: unknown): string {
  const key = normalizeOptionalString(value) ?? "";
  return key && !isBlockedObjectKey(key) ? key : "";
}

function normalizeOwnedProviderSet(providers: ReadonlySet<string>): ReadonlySet<string> {
  const normalized = new Set<string>();
  for (const provider of providers) {
    const providerId = normalizeModelCatalogProviderId(provider);
    if (providerId) {
      normalized.add(providerId);
    }
  }
  return normalized;
}

function normalizeStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizeSafeRecordKey(rawKey);
    const mapValue = normalizeOptionalString(rawValue) ?? "";
    if (key && mapValue) {
      normalized[key] = mapValue;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function mergeStringMaps(
  base: Record<string, string> | undefined,
  override: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!base && !override) {
    return undefined;
  }
  return { ...base, ...override };
}

function normalizeModelCatalogApi(value: unknown): ModelApi | undefined {
  const api = normalizeOptionalString(value) ?? "";
  return MODEL_CATALOG_APIS.has(api) ? (api as ModelApi) : undefined;
}

function normalizeModelCatalogInputs(value: unknown): ModelCatalogInput[] | undefined {
  const inputs = normalizeTrimmedStringList(value).filter((input): input is ModelCatalogInput =>
    MODEL_CATALOG_INPUTS.has(input),
  );
  return inputs.length > 0 ? inputs : undefined;
}

function normalizeNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizeModelCatalogTieredCost(value: unknown): ModelCatalogTieredCost[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: ModelCatalogTieredCost[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !Array.isArray(entry.range)) {
      continue;
    }
    const input = normalizeNonNegativeNumber(entry.input);
    const output = normalizeNonNegativeNumber(entry.output);
    const cacheRead = normalizeNonNegativeNumber(entry.cacheRead);
    const cacheWrite = normalizeNonNegativeNumber(entry.cacheWrite);
    if (
      input === undefined ||
      output === undefined ||
      cacheRead === undefined ||
      cacheWrite === undefined ||
      entry.range.length < 1 ||
      entry.range.length > 2
    ) {
      continue;
    }
    const rangeValues = entry.range.map((rangeValue) => normalizeNonNegativeNumber(rangeValue));
    if (rangeValues.some((rangeValue) => rangeValue === undefined)) {
      continue;
    }
    normalized.push({
      input,
      output,
      cacheRead,
      cacheWrite,
      range:
        rangeValues.length === 1
          ? ([rangeValues[0]] as [number])
          : ([rangeValues[0], rangeValues[1]] as [number, number]),
    });
  }
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeModelCatalogCost(value: unknown): ModelCatalogCost | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const input = normalizeNonNegativeNumber(value.input);
  const output = normalizeNonNegativeNumber(value.output);
  const cacheRead = normalizeNonNegativeNumber(value.cacheRead);
  const cacheWrite = normalizeNonNegativeNumber(value.cacheWrite);
  const tieredPricing = normalizeModelCatalogTieredCost(value.tieredPricing);
  const cost = {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(tieredPricing ? { tieredPricing } : {}),
  } satisfies ModelCatalogCost;
  return Object.keys(cost).length > 0 ? cost : undefined;
}

function normalizeModelCatalogCompat(value: unknown): ModelCompatConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const compat: Record<string, unknown> = {};
  const booleanFields = [
    "supportsStore",
    "supportsPromptCacheKey",
    "supportsDeveloperRole",
    "supportsReasoningEffort",
    "supportsUsageInStreaming",
    "supportsTools",
    "supportsStrictMode",
    "requiresStringContent",
    "requiresToolResultName",
    "requiresAssistantAfterToolResult",
    "requiresThinkingAsText",
    "nativeWebSearchTool",
    "requiresMistralToolIds",
    "requiresOpenAiAnthropicToolPayload",
  ] as const;
  for (const field of booleanFields) {
    if (typeof value[field] === "boolean") {
      compat[field] = value[field];
    }
  }

  const stringFields = ["toolSchemaProfile", "toolCallArgumentsEncoding"] as const;
  for (const field of stringFields) {
    const normalized = normalizeOptionalString(value[field]) ?? "";
    if (normalized) {
      compat[field] = normalized;
    }
  }

  const stringListFields = [
    "visibleReasoningDetailTypes",
    "supportedReasoningEfforts",
    "unsupportedToolSchemaKeywords",
  ] as const;
  for (const field of stringListFields) {
    const normalized = normalizeTrimmedStringList(value[field]);
    if (normalized.length > 0) {
      compat[field] = normalized;
    }
  }

  const maxTokensField = normalizeOptionalString(value.maxTokensField) ?? "";
  if (maxTokensField === "max_completion_tokens" || maxTokensField === "max_tokens") {
    compat.maxTokensField = maxTokensField;
  }

  const thinkingFormat = normalizeOptionalString(value.thinkingFormat) ?? "";
  if (
    thinkingFormat === "openai" ||
    thinkingFormat === "openrouter" ||
    thinkingFormat === "deepseek" ||
    thinkingFormat === "zai" ||
    thinkingFormat === "qwen" ||
    thinkingFormat === "qwen-chat-template"
  ) {
    compat.thinkingFormat = thinkingFormat;
  }

  return Object.keys(compat).length > 0 ? (compat as ModelCompatConfig) : undefined;
}

function normalizeModelCatalogStatus(value: unknown): ModelCatalogStatus | undefined {
  const status = normalizeOptionalString(value) ?? "";
  return MODEL_CATALOG_STATUSES.has(status) ? (status as ModelCatalogStatus) : undefined;
}

function normalizeModelCatalogModel(value: unknown): ModelCatalogModel | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = normalizeOptionalString(value.id) ?? "";
  if (!id) {
    return undefined;
  }
  const name = normalizeOptionalString(value.name) ?? "";
  const api = normalizeModelCatalogApi(value.api);
  const baseUrl = normalizeOptionalString(value.baseUrl) ?? "";
  const headers = normalizeStringMap(value.headers);
  const input = normalizeModelCatalogInputs(value.input);
  const reasoning = typeof value.reasoning === "boolean" ? value.reasoning : undefined;
  const contextWindow = normalizePositiveNumber(value.contextWindow);
  const contextTokens = normalizePositiveInteger(value.contextTokens);
  const maxTokens = normalizePositiveNumber(value.maxTokens);
  const cost = normalizeModelCatalogCost(value.cost);
  const compat = normalizeModelCatalogCompat(value.compat);
  const status = normalizeModelCatalogStatus(value.status);
  const statusReason = normalizeOptionalString(value.statusReason) ?? "";
  const replaces = normalizeTrimmedStringList(value.replaces);
  const replacedBy = normalizeOptionalString(value.replacedBy) ?? "";
  const tags = normalizeTrimmedStringList(value.tags);
  return {
    id,
    ...(name ? { name } : {}),
    ...(api ? { api } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(headers ? { headers } : {}),
    ...(input ? { input } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(cost ? { cost } : {}),
    ...(compat ? { compat } : {}),
    ...(status ? { status } : {}),
    ...(statusReason ? { statusReason } : {}),
    ...(replaces.length > 0 ? { replaces } : {}),
    ...(replacedBy ? { replacedBy } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

function normalizeModelCatalogProvider(value: unknown): ModelCatalogProvider | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const models = Array.isArray(value.models)
    ? value.models
        .map((entry) => normalizeModelCatalogModel(entry))
        .filter((entry): entry is ModelCatalogModel => Boolean(entry))
    : [];
  if (models.length === 0) {
    return undefined;
  }
  const baseUrl = normalizeOptionalString(value.baseUrl) ?? "";
  const api = normalizeModelCatalogApi(value.api);
  const headers = normalizeStringMap(value.headers);
  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(api ? { api } : {}),
    ...(headers ? { headers } : {}),
    models,
  };
}

function normalizeModelCatalogProviders(
  value: unknown,
  ownedProviders: ReadonlySet<string>,
): Record<string, ModelCatalogProvider> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const providers: Record<string, ModelCatalogProvider> = {};
  for (const [rawProviderId, rawProvider] of Object.entries(value)) {
    const providerId = normalizeModelCatalogProviderId(rawProviderId);
    if (!providerId || !ownedProviders.has(providerId)) {
      continue;
    }
    const provider = normalizeModelCatalogProvider(rawProvider);
    if (provider) {
      providers[providerId] = provider;
    }
  }
  return Object.keys(providers).length > 0 ? providers : undefined;
}

function normalizeModelCatalogAliases(
  value: unknown,
  ownedProviders: ReadonlySet<string>,
): Record<string, ModelCatalogAlias> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const aliases: Record<string, ModelCatalogAlias> = {};
  for (const [rawAlias, rawTarget] of Object.entries(value)) {
    const alias = normalizeModelCatalogProviderId(rawAlias);
    if (!alias || !isRecord(rawTarget)) {
      continue;
    }
    const provider = normalizeModelCatalogProviderId(
      normalizeOptionalString(rawTarget.provider) ?? "",
    );
    if (!provider || !ownedProviders.has(provider)) {
      continue;
    }
    const api = normalizeModelCatalogApi(rawTarget.api);
    const baseUrl = normalizeOptionalString(rawTarget.baseUrl) ?? "";
    aliases[alias] = {
      provider,
      ...(api ? { api } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    };
  }
  return Object.keys(aliases).length > 0 ? aliases : undefined;
}

function normalizeModelCatalogSuppressions(value: unknown): ModelCatalogSuppression[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const suppressions: ModelCatalogSuppression[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const provider = normalizeModelCatalogProviderId(normalizeOptionalString(entry.provider) ?? "");
    const model = normalizeOptionalString(entry.model) ?? "";
    if (!provider || !model) {
      continue;
    }
    const reason = normalizeOptionalString(entry.reason) ?? "";
    suppressions.push({
      provider,
      model,
      ...(reason ? { reason } : {}),
    });
  }
  return suppressions.length > 0 ? suppressions : undefined;
}

function normalizeModelCatalogDiscovery(
  value: unknown,
  ownedProviders: ReadonlySet<string>,
): Record<string, ModelCatalogDiscovery> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const discovery: Record<string, ModelCatalogDiscovery> = {};
  for (const [rawProviderId, rawMode] of Object.entries(value)) {
    const providerId = normalizeModelCatalogProviderId(rawProviderId);
    const mode = normalizeOptionalString(rawMode) ?? "";
    if (providerId && ownedProviders.has(providerId) && MODEL_CATALOG_DISCOVERY_MODES.has(mode)) {
      discovery[providerId] = mode as ModelCatalogDiscovery;
    }
  }
  return Object.keys(discovery).length > 0 ? discovery : undefined;
}

export function normalizeModelCatalog(
  value: unknown,
  params: { ownedProviders: ReadonlySet<string> },
): ModelCatalog | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const ownedProviders = normalizeOwnedProviderSet(params.ownedProviders);
  const providers = normalizeModelCatalogProviders(value.providers, ownedProviders);
  const aliases = normalizeModelCatalogAliases(value.aliases, ownedProviders);
  const suppressions = normalizeModelCatalogSuppressions(value.suppressions);
  const discovery = normalizeModelCatalogDiscovery(value.discovery, ownedProviders);
  const catalog = {
    ...(providers ? { providers } : {}),
    ...(aliases ? { aliases } : {}),
    ...(suppressions ? { suppressions } : {}),
    ...(discovery ? { discovery } : {}),
  } satisfies ModelCatalog;
  return Object.keys(catalog).length > 0 ? catalog : undefined;
}

function normalizeStringList(value: unknown): string[] | undefined {
  const normalized = normalizeTrimmedStringList(value);
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeModelCatalogProviderRows(params: {
  provider: string;
  providerCatalog: ModelCatalogProvider;
  source: ModelCatalogSource;
}): NormalizedModelCatalogRow[] {
  const provider = normalizeModelCatalogProviderId(params.provider);
  if (!provider || !Array.isArray(params.providerCatalog.models)) {
    return [];
  }
  const providerApi = normalizeModelCatalogApi(params.providerCatalog.api);
  const providerBaseUrl = normalizeOptionalString(params.providerCatalog.baseUrl) ?? "";
  const providerHeaders = normalizeStringMap(params.providerCatalog.headers);
  const rows: NormalizedModelCatalogRow[] = [];

  for (const model of params.providerCatalog.models) {
    const id = normalizeOptionalString(model.id) ?? "";
    if (!id) {
      continue;
    }
    const api = normalizeModelCatalogApi(model.api) ?? providerApi;
    const baseUrl = normalizeOptionalString(model.baseUrl) ?? providerBaseUrl;
    const headers = mergeStringMaps(providerHeaders, normalizeStringMap(model.headers));
    const contextWindow = normalizePositiveNumber(model.contextWindow);
    const contextTokens = normalizePositiveInteger(model.contextTokens);
    const maxTokens = normalizePositiveNumber(model.maxTokens);
    const cost = normalizeModelCatalogCost(model.cost);
    const compat = normalizeModelCatalogCompat(model.compat);
    const statusReason = normalizeOptionalString(model.statusReason) ?? "";
    const replacedBy = normalizeOptionalString(model.replacedBy) ?? "";
    const replaces = normalizeStringList(model.replaces);
    const tags = normalizeStringList(model.tags);
    rows.push({
      provider,
      id,
      ref: buildModelCatalogRef(provider, id),
      mergeKey: buildModelCatalogMergeKey(provider, id),
      name: normalizeOptionalString(model.name) || id,
      source: params.source,
      input: normalizeModelCatalogInputs(model.input) ?? [...DEFAULT_MODEL_INPUT],
      reasoning: typeof model.reasoning === "boolean" ? model.reasoning : false,
      status: normalizeModelCatalogStatus(model.status) ?? DEFAULT_MODEL_STATUS,
      ...(api ? { api } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(headers ? { headers } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(contextTokens !== undefined ? { contextTokens } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(cost ? { cost } : {}),
      ...(compat ? { compat } : {}),
      ...(statusReason ? { statusReason } : {}),
      ...(replaces ? { replaces } : {}),
      ...(replacedBy ? { replacedBy } : {}),
      ...(tags ? { tags } : {}),
    });
  }

  return rows.toSorted((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
}

export function normalizeModelCatalogRows(params: {
  providers: Record<string, ModelCatalogProvider>;
  source: ModelCatalogSource;
}): NormalizedModelCatalogRow[] {
  return Object.entries(params.providers)
    .flatMap(([provider, providerCatalog]) =>
      normalizeModelCatalogProviderRows({ provider, providerCatalog, source: params.source }),
    )
    .toSorted((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
}
