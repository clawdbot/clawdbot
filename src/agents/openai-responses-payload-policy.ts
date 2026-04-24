import { readStringValue } from "../shared/string-coerce.js";
import { supportsOpenAIReasoningEffort } from "./openai-reasoning-effort.js";
import { isOpenAIResponsesApi } from "./provider-attribution.js";
import { resolveProviderRequestPolicyConfig } from "./provider-request-config.js";

type OpenAIResponsesPayloadModel = {
  api?: unknown;
  baseUrl?: unknown;
  id?: unknown;
  provider?: unknown;
  contextWindow?: unknown;
  compat?: unknown;
};

type OpenAIResponsesPayloadPolicyOptions = {
  extraParams?: Record<string, unknown>;
  storeMode?: "provider-policy" | "disable" | "preserve";
  enablePromptCacheStripping?: boolean;
  enableServerCompaction?: boolean;
};

export type OpenAIResponsesPayloadPolicy = {
  allowsServiceTier: boolean;
  compactThreshold: number;
  explicitStore: boolean | undefined;
  shouldStripDisabledReasoningPayload: boolean;
  shouldStripPromptCache: boolean;
  shouldStripStore: boolean;
  useServerCompaction: boolean;
};

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function resolveOpenAIResponsesCompactThreshold(model: { contextWindow?: unknown }): number {
  const contextWindow = parsePositiveInteger(model.contextWindow);
  if (contextWindow) {
    return Math.max(1_000, Math.floor(contextWindow * 0.7));
  }
  return 80_000;
}

function readCompatBoolean(compat: unknown, key: "supportsStore"): boolean | undefined {
  if (!compat || typeof compat !== "object") {
    return undefined;
  }
  const value = (compat as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

function shouldEnableOpenAIResponsesServerCompaction(
  explicitStore: boolean | undefined,
  provider: unknown,
  extraParams: Record<string, unknown> | undefined,
): boolean {
  const configured = extraParams?.responsesServerCompaction;
  if (configured === false) {
    return false;
  }
  if (explicitStore !== true) {
    return false;
  }
  if (configured === true) {
    return true;
  }
  return provider === "openai";
}

function stripDisabledOpenAIReasoningPayload(payloadObj: Record<string, unknown>): void {
  const reasoning = payloadObj.reasoning;
  if (reasoning === "none") {
    delete payloadObj.reasoning;
    return;
  }
  if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) {
    return;
  }

  // Some Responses models and OpenAI-compatible proxies reject
  // `reasoning.effort: "none"`. Treat unsupported disabled effort as omitted.
  const reasoningObj = reasoning as Record<string, unknown>;
  if (reasoningObj.effort === "none") {
    delete payloadObj.reasoning;
  }
}

export function resolveOpenAIResponsesPayloadPolicy(
  model: OpenAIResponsesPayloadModel,
  options: OpenAIResponsesPayloadPolicyOptions = {},
): OpenAIResponsesPayloadPolicy {
  const compat =
    model.compat && typeof model.compat === "object"
      ? (model.compat as { supportsStore?: boolean })
      : undefined;
  const capabilities = resolveProviderRequestPolicyConfig({
    provider: readStringValue(model.provider),
    api: readStringValue(model.api),
    baseUrl: readStringValue(model.baseUrl),
    compat,
    capability: "llm",
    transport: "stream",
  }).capabilities;
  const storeMode = options.storeMode ?? "provider-policy";
  const explicitStore =
    storeMode === "preserve"
      ? undefined
      : storeMode === "disable"
        ? capabilities.supportsResponsesStoreField
          ? false
          : undefined
        : capabilities.allowsResponsesStore
          ? true
          : undefined;
  const isResponsesApi = isOpenAIResponsesApi(readStringValue(model.api));
  const shouldStripDisabledReasoningPayload =
    isResponsesApi &&
    (!capabilities.usesKnownNativeOpenAIRoute || !supportsOpenAIReasoningEffort(model, "none"));

  return {
    allowsServiceTier: capabilities.allowsOpenAIServiceTier,
    compactThreshold:
      parsePositiveInteger(options.extraParams?.responsesCompactThreshold) ??
      resolveOpenAIResponsesCompactThreshold(model),
    explicitStore,
    shouldStripDisabledReasoningPayload,
    shouldStripPromptCache:
      options.enablePromptCacheStripping === true && capabilities.shouldStripResponsesPromptCache,
    shouldStripStore:
      explicitStore !== true &&
      readCompatBoolean(model.compat, "supportsStore") === false &&
      isResponsesApi,
    useServerCompaction:
      options.enableServerCompaction === true &&
      shouldEnableOpenAIResponsesServerCompaction(
        explicitStore,
        model.provider,
        options.extraParams,
      ),
  };
}

export function applyOpenAIResponsesPayloadPolicy(
  payloadObj: Record<string, unknown>,
  policy: OpenAIResponsesPayloadPolicy,
): void {
  if (policy.explicitStore !== undefined) {
    payloadObj.store = policy.explicitStore;
  }
  if (policy.shouldStripStore) {
    delete payloadObj.store;
  }
  if (policy.shouldStripPromptCache) {
    delete payloadObj.prompt_cache_key;
    delete payloadObj.prompt_cache_retention;
  }
  if (policy.useServerCompaction && payloadObj.context_management === undefined) {
    payloadObj.context_management = [
      {
        type: "compaction",
        compact_threshold: policy.compactThreshold,
      },
    ];
  }
  if (policy.shouldStripDisabledReasoningPayload) {
    stripDisabledOpenAIReasoningPayload(payloadObj);
  }
}
