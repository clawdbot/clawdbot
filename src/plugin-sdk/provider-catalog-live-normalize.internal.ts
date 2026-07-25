import type { ModelDefinitionConfig, ModelProviderConfig } from "./provider-model-shared.js";

export function readLiveModelCatalogRecord(body: unknown): Record<string, unknown> | undefined {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
}

function readLiveModelString(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readLiveModelBoolean(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): boolean | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function readLiveModelPositiveInteger(
  records: readonly (Record<string, unknown> | undefined)[],
  keys: readonly string[],
): number | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = record?.[key];
      if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
        return value;
      }
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
  const kind = readLiveModelString(record, [
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
  const explicitChatCapability = readLiveModelBoolean(nestedRecords[0], [
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

function buildOpenAICompatibleLiveModel(
  row: unknown,
  fallback: ModelProviderConfig,
): ModelDefinitionConfig | undefined {
  const record = readLiveModelCatalogRecord(row);
  const id = readLiveModelString(record, ["id", "model", "model_name", "modelName"]);
  if (!record || !id || !isSafeLiveModelId(id)) {
    return undefined;
  }
  if (readLiveModelBoolean(record, ["active", "enabled", "available"]) === false) {
    return undefined;
  }
  if (readLiveModelBoolean(record, ["archived", "deprecated"]) === true) {
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
    return exact;
  }
  const template = findLiveModelTemplate(id, fallback.models);
  const inputModalities = readLiveModelStringArray(
    [record, architecture, capabilities, modelInfo],
    ["input_modalities", "inputModalities", "input"],
  );
  const contextWindow =
    readLiveModelPositiveInteger(
      [record, topProvider, capabilities, modelInfo],
      [
        "context_window",
        "contextWindow",
        "context_length",
        "contextLength",
        "context_size",
        "contextSize",
        "max_context_length",
        "maxModelLen",
        "max_model_len",
      ],
    ) ??
    fallback.contextWindow ??
    template?.contextWindow ??
    128_000;
  const maxTokens =
    readLiveModelPositiveInteger(
      [record, topProvider, capabilities, modelInfo],
      [
        "max_completion_tokens",
        "maxCompletionTokens",
        "max_output_tokens",
        "maxOutputTokens",
        "output_token_limit",
        "outputTokenLimit",
      ],
    ) ??
    fallback.maxTokens ??
    template?.maxTokens ??
    Math.min(contextWindow, 8192);
  const explicitReasoning = readLiveModelBoolean(record, [
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
    name: readLiveModelString(record, ["display_name", "displayName", "name"]) ?? id,
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
): ModelDefinitionConfig[] {
  const models = rows
    .map((row) => buildOpenAICompatibleLiveModel(row, fallback))
    .filter((model): model is ModelDefinitionConfig => Boolean(model));
  return [...new Map(models.map((model) => [model.id, model])).values()].toSorted((a, b) =>
    a.id.localeCompare(b.id),
  );
}
