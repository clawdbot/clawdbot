import { normalizeUpstreamModelPricing } from "@openclaw/model-catalog-core/model-catalog-pricing";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { ModelDefinitionConfig, ModelProviderConfig } from "./provider-model-shared.js";

export type UpstreamProviderCatalogModel = Record<string, unknown> & {
  id: string;
  limit: Record<string, unknown> & { context: number; output: number };
};

export type UpstreamProviderCatalog = {
  id: string;
  api?: string;
  npm?: string;
  models: Record<string, UpstreamProviderCatalogModel>;
};

export type ProjectedUpstreamProviderCatalogModel = ModelDefinitionConfig & {
  provider: string;
  api: NonNullable<ModelDefinitionConfig["api"]>;
  baseUrl: string;
  input: Array<"text" | "image">;
};

export function readLiveModelCatalogId(row: unknown): string | undefined {
  const record = readLiveModelCatalogRecord(row);
  if (record?.object !== undefined && record.object !== "model") {
    return undefined;
  }
  return readLiveModelCatalogStringField(record, "id");
}

export function readLiveModelCatalogRecord(body: unknown): Record<string, unknown> | undefined {
  return asOptionalRecord(body);
}

export function readLiveModelCatalogStringField(
  row: unknown,
  keys: string | readonly string[],
): string | undefined {
  const record = readLiveModelCatalogRecord(row);
  for (const key of typeof keys === "string" ? [keys] : keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function readLiveModelCatalogBooleanField(
  row: unknown,
  keys: string | readonly string[],
): boolean | undefined {
  const record = readLiveModelCatalogRecord(row);
  for (const key of typeof keys === "string" ? [keys] : keys) {
    const value = record?.[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

export function readLiveModelCatalogPositiveSafeIntegerField(
  row: unknown,
  keys: string | readonly string[],
): number | undefined {
  const record = readLiveModelCatalogRecord(row);
  for (const key of typeof keys === "string" ? [keys] : keys) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

export function isUpstreamProviderCatalogModel(
  value: unknown,
): value is UpstreamProviderCatalogModel {
  const model = readLiveModelCatalogRecord(value);
  const limits = readLiveModelCatalogRecord(model?.limit);
  return Boolean(
    readLiveModelCatalogStringField(model, "id") &&
    readLiveModelCatalogPositiveSafeIntegerField(limits, "context") &&
    readLiveModelCatalogPositiveSafeIntegerField(limits, "output"),
  );
}

function readLiveModelPositiveIntegerFromRecords(
  records: readonly (Record<string, unknown> | undefined)[],
  keys: readonly string[],
): number | undefined {
  for (const record of records) {
    const value = readLiveModelCatalogPositiveSafeIntegerField(record, keys);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function readLiveModelStringArray(
  records: readonly (Record<string, unknown> | undefined)[],
  keys: readonly string[],
): string[] {
  for (const record of records) {
    for (const key of keys) {
      const value = record?.[key];
      if (Array.isArray(value)) {
        const strings = value
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim().toLowerCase())
          .filter(Boolean);
        if (strings.length > 0) {
          return strings;
        }
      }
    }
  }
  return [];
}

function isSafeLiveModelId(value: string): boolean {
  if (!value || value.length > 512) {
    return false;
  }
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || codePoint === 0x7f) {
      return false;
    }
  }
  return true;
}

const NON_TEXT_MODEL_ID_PATTERN =
  /(?:^|[/_:.-])(?:embed(?:ding)?|rerank(?:er)?|whisper|transcri(?:be|ption)|tts|speech|moderation|guard|gpt-image|dall-e|flux|sdxl|stable-diffusion|imagen|image-gen(?:eration)?|text-to-image|veo|sora|video-gen(?:eration)?|text-to-video)(?:$|[/_:.-])/i;

function rowAdvertisesNonTextModel(
  record: Record<string, unknown>,
  nestedRecords: readonly (Record<string, unknown> | undefined)[],
): boolean {
  const outputModalities = readLiveModelStringArray(
    [record, ...nestedRecords],
    ["output_modalities", "outputModalities", "output"],
  );
  if (outputModalities.length > 0 && !outputModalities.includes("text")) {
    return true;
  }
  const kind = readLiveModelCatalogStringField(record, [
    "type",
    "task",
    "model_type",
    "modelType",
    "pipeline_tag",
  ]);
  return Boolean(kind && NON_TEXT_MODEL_ID_PATTERN.test(kind));
}

function rowAdvertisesChatModel(
  record: Record<string, unknown>,
  nestedRecords: readonly (Record<string, unknown> | undefined)[],
): boolean | undefined {
  const explicitChatCapability = readLiveModelCatalogBooleanField(nestedRecords[0], [
    "completion_chat",
    "chat_completion",
    "chatCompletion",
  ]);
  if (explicitChatCapability !== undefined) {
    return explicitChatCapability;
  }
  const capabilityStrings = readLiveModelStringArray(
    [record, ...nestedRecords],
    ["capabilities", "features", "endpoints", "supported_endpoints"],
  );
  if (
    capabilityStrings.some((value) =>
      /(?:^|[./:])(?:chat|responses?|generate|completions?)(?:$|[./:])|(?:^|[./:_-])(?:chat[-_]completions?|completions?[-_]chat|text[-_]generation)(?:$|[./:_-])/.test(
        value,
      ),
    )
  ) {
    return true;
  }
  return undefined;
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function findLiveModelTemplate(
  modelId: string,
  models: readonly ModelDefinitionConfig[],
): ModelDefinitionConfig | undefined {
  const exact = models.find((model) => model.id === modelId);
  if (exact) {
    return exact;
  }
  const normalizedId = modelId.toLowerCase();
  let best: ModelDefinitionConfig | undefined;
  let bestScore = 0;
  for (const model of models) {
    const score = commonPrefixLength(normalizedId, model.id.toLowerCase());
    if (score > bestScore) {
      best = model;
      bestScore = score;
    }
  }
  return bestScore >= 4 ? best : undefined;
}

function inferLiveModelReasoning(modelId: string): boolean {
  return /(?:^|[/_:.-])(?:reason(?:er|ing)?|thinking|deepseek-r1|o[134](?:-mini)?|gpt-5)(?:$|[/_:.-])/i.test(
    modelId,
  );
}

function readLiveModelContextWindow(
  records: readonly (Record<string, unknown> | undefined)[],
): number | undefined {
  return readLiveModelPositiveIntegerFromRecords(records, [
    "context_window",
    "contextWindow",
    "context_length",
    "contextLength",
    "context_size",
    "contextSize",
    "max_context_length",
    "maxModelLen",
    "max_model_len",
    // Anthropic names the context window by its input side. Appended so a
    // provider already matching an earlier key keeps its current value.
    "max_input_tokens",
    "maxInputTokens",
  ]);
}

function buildOpenAICompatibleLiveModel(
  row: unknown,
  fallback: ModelProviderConfig,
  acceptUnknownModel?: (params: { id: string; record: Record<string, unknown> }) => boolean,
): ModelDefinitionConfig | undefined {
  const record = readLiveModelCatalogRecord(row);
  const id = readLiveModelCatalogStringField(record, ["id", "model", "model_name", "modelName"]);
  if (!record || !id || !isSafeLiveModelId(id)) {
    return undefined;
  }
  if (readLiveModelCatalogBooleanField(record, ["active", "enabled", "available"]) === false) {
    return undefined;
  }
  if (readLiveModelCatalogBooleanField(record, ["archived", "deprecated"]) === true) {
    return undefined;
  }
  const capabilities = readLiveModelCatalogRecord(record.capabilities);
  const architecture = readLiveModelCatalogRecord(record.architecture);
  const topProvider = readLiveModelCatalogRecord(record.top_provider);
  const modelInfo = readLiveModelCatalogRecord(record.model_info);
  const nestedRecords = [capabilities, architecture, topProvider, modelInfo];
  const advertisedChatCapability = rowAdvertisesChatModel(record, nestedRecords);
  if (
    advertisedChatCapability === false ||
    (advertisedChatCapability !== true &&
      (rowAdvertisesNonTextModel(record, nestedRecords) || NON_TEXT_MODEL_ID_PATTERN.test(id)))
  ) {
    return undefined;
  }

  const exact = fallback.models.find((model) => model.id === id);
  if (exact) {
    const liveContextWindow = readLiveModelContextWindow([record, ...nestedRecords]);
    return exact.contextWindow === undefined && liveContextWindow !== undefined
      ? { ...exact, contextWindow: liveContextWindow }
      : exact;
  }
  // Manifest-published ids returned above are known-good. Everything past this
  // point is a model the manifest has never described, so an opted-in provider
  // gate decides whether its request shaping is understood well enough to
  // surface it at all.
  if (acceptUnknownModel && !acceptUnknownModel({ id, record })) {
    return undefined;
  }
  const template = findLiveModelTemplate(id, fallback.models);
  const inputModalities = readLiveModelStringArray(
    [record, architecture, capabilities, modelInfo],
    ["input_modalities", "inputModalities", "input"],
  );
  const contextWindow =
    readLiveModelContextWindow([record, ...nestedRecords]) ?? template?.contextWindow ?? 128_000;
  const maxTokens =
    readLiveModelPositiveIntegerFromRecords(
      [record, topProvider, capabilities, modelInfo],
      [
        "max_completion_tokens",
        "maxCompletionTokens",
        "max_output_tokens",
        "maxOutputTokens",
        "output_token_limit",
        "outputTokenLimit",
        // Anthropic reports the output cap as max_tokens. Kept last so the
        // unambiguous completion-specific names above still win where both
        // appear, and no provider's existing resolution changes.
        "max_tokens",
        "maxTokens",
      ],
    ) ??
    fallback.maxTokens ??
    template?.maxTokens ??
    Math.min(contextWindow, 8192);
  const explicitReasoning = readLiveModelCatalogBooleanField(record, [
    "reasoning",
    "supports_reasoning",
    "supportsReasoning",
    "thinking",
  ]);
  const featureNames = readLiveModelStringArray(
    [record, capabilities, modelInfo],
    ["features", "supported_parameters", "supportedParameters"],
  );
  const reasoning =
    explicitReasoning ??
    (featureNames.some((feature) => /reason|think/.test(feature)) ||
      template?.reasoning === true ||
      inferLiveModelReasoning(id));
  const input: ModelDefinitionConfig["input"] = inputModalities.includes("image")
    ? ["text", "image"]
    : (template?.input ?? ["text"]);

  return {
    id,
    name: readLiveModelCatalogStringField(record, ["display_name", "displayName", "name"]) ?? id,
    ...(template?.api ? { api: template.api } : {}),
    reasoning,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    ...(template?.compat ? { compat: template.compat } : {}),
    ...(template?.thinkingLevelMap ? { thinkingLevelMap: template.thinkingLevelMap } : {}),
  };
}

export function buildOpenAICompatibleLiveModels(
  rows: readonly unknown[],
  fallback: ModelProviderConfig,
  acceptUnknownModel?: (params: { id: string; record: Record<string, unknown> }) => boolean,
): ModelDefinitionConfig[] {
  const models = rows
    .map((row) => buildOpenAICompatibleLiveModel(row, fallback, acceptUnknownModel))
    .filter((model): model is ModelDefinitionConfig => Boolean(model));
  return [...new Map(models.map((model) => [model.id, model])).values()].toSorted((a, b) =>
    a.id.localeCompare(b.id),
  );
}

function parseUpstreamProviderCatalogUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

const UPSTREAM_PROVIDER_API_BY_PACKAGE = new Map<
  string,
  ProjectedUpstreamProviderCatalogModel["api"]
>([
  ["@ai-sdk/anthropic", "anthropic-messages"],
  ["@ai-sdk/google", "google-generative-ai"],
  ["@ai-sdk/openai", "openai-responses"],
  ["@ai-sdk/openai-compatible", "openai-completions"],
]);

/** Projects authoritative provider-owned model metadata into its runtime transport and capabilities. */
export function projectUpstreamProviderCatalogModel(params: {
  providerId: string;
  provider: UpstreamProviderCatalog;
  model: UpstreamProviderCatalogModel | undefined;
  anthropicBaseUrl?: string;
  defaultBaseUrl?: string;
}): ProjectedUpstreamProviderCatalogModel | undefined {
  const model = readLiveModelCatalogRecord(params.model);
  const limit = readLiveModelCatalogRecord(model?.limit);
  const id = readLiveModelCatalogStringField(model, "id");
  const contextWindow = readLiveModelCatalogPositiveSafeIntegerField(limit, "context");
  const maxTokens = readLiveModelCatalogPositiveSafeIntegerField(limit, "output");
  if (!model || !id || !contextWindow || !maxTokens) {
    return undefined;
  }

  const modelProvider = readLiveModelCatalogRecord(model.provider);
  const npm =
    readLiveModelCatalogStringField(modelProvider, "npm") ??
    params.provider.npm ??
    "@ai-sdk/openai-compatible";
  const api = UPSTREAM_PROVIDER_API_BY_PACKAGE.get(npm);
  if (!api) {
    return undefined;
  }
  const canonicalBaseUrl = params.defaultBaseUrl ?? params.provider.api;
  const canonicalOrigin = canonicalBaseUrl
    ? parseUpstreamProviderCatalogUrl(canonicalBaseUrl)?.origin
    : undefined;
  const providerBaseUrl = params.provider.api ?? params.defaultBaseUrl;
  const modelBaseUrl = readLiveModelCatalogStringField(modelProvider, "api");
  if (
    !canonicalOrigin ||
    (providerBaseUrl &&
      parseUpstreamProviderCatalogUrl(providerBaseUrl)?.origin !== canonicalOrigin) ||
    (modelBaseUrl && parseUpstreamProviderCatalogUrl(modelBaseUrl)?.origin !== canonicalOrigin)
  ) {
    // Metadata chooses transport, but must never redirect authenticated inference
    // away from the provider endpoint trusted by its owner plugin.
    return undefined;
  }
  const upstreamBaseUrl = modelBaseUrl ?? providerBaseUrl;
  const baseUrl =
    api === "anthropic-messages"
      ? (params.anthropicBaseUrl ?? upstreamBaseUrl?.replace(/\/v1\/?$/, ""))
      : upstreamBaseUrl;
  if (!baseUrl || parseUpstreamProviderCatalogUrl(baseUrl)?.origin !== canonicalOrigin) {
    return undefined;
  }

  const modalities = readLiveModelCatalogRecord(model.modalities);
  const input: ProjectedUpstreamProviderCatalogModel["input"] = ["text"];
  if (Array.isArray(modalities?.input) && modalities.input.includes("image")) {
    input.push("image");
  }
  const reasoningOptions = Array.isArray(model.reasoning_options) ? model.reasoning_options : [];
  const reasoningEfforts = [
    ...new Set(
      reasoningOptions.flatMap((option) => {
        const record = readLiveModelCatalogRecord(option);
        return record?.type === "effort" && Array.isArray(record.values)
          ? record.values.filter(
              (value): value is string => typeof value === "string" && Boolean(value),
            )
          : [];
      }),
    ),
  ];
  const contextTokens = readLiveModelCatalogPositiveSafeIntegerField(limit, "input");
  return {
    id,
    name: readLiveModelCatalogStringField(model, "name") ?? id,
    provider: params.providerId,
    api,
    baseUrl,
    reasoning: readLiveModelCatalogBooleanField(model, "reasoning") ?? false,
    input,
    cost: normalizeUpstreamModelPricing(model.cost) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow,
    ...(contextTokens && contextTokens <= contextWindow ? { contextTokens } : {}),
    maxTokens,
    ...(api === "openai-responses" &&
    reasoningEfforts.length > 0 &&
    !reasoningEfforts.includes("none")
      ? { thinkingLevelMap: { off: null } }
      : {}),
    compat: {
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
      ...(typeof model.tool_call === "boolean" ? { supportsTools: model.tool_call } : {}),
      ...(reasoningEfforts.length > 0
        ? { supportsReasoningEffort: true, supportedReasoningEfforts: reasoningEfforts }
        : {}),
      ...(api === "openai-completions"
        ? { supportsDeveloperRole: false, supportsStrictMode: false }
        : {}),
    },
  };
}
