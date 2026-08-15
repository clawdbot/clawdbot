import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
/**
 * OpenAI Responses payload policy.
 * Classifies endpoint capabilities and applies store, prompt-cache,
 * server-compaction, service-tier, and reasoning payload rules.
 */
import {
  normalizeOptionalLowercaseString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { supportsOpenAIReasoningEffort } from "../providers/openai-reasoning-effort.js";
import { OPENAI_RESPONSES_APIS } from "./openai-responses-contracts.js";

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

type OpenAIResponsesEndpointClass =
  | "default"
  | "anthropic-public"
  | "cerebras-native"
  | "chutes-native"
  | "deepseek-native"
  | "github-copilot-native"
  | "groq-native"
  | "mistral-public"
  | "moonshot-native"
  | "modelstudio-native"
  | "openai-public"
  | "openai"
  | "opencode-native"
  | "azure-openai"
  | "openrouter"
  | "xai-native"
  | "zai-native"
  | "google-generative-ai"
  | "google-vertex"
  | "local"
  | "custom"
  | "invalid";

type OpenAIResponsesPayloadPolicy = {
  allowsServiceTier: boolean;
  compactThreshold: number | undefined;
  explicitStore: boolean | undefined;
  shouldStripDisabledReasoningPayload: boolean;
  shouldStripInputStatus: boolean;
  shouldStripPromptCache: boolean;
  shouldStripStore: boolean;
  useServerCompaction: boolean;
};

type OpenAIResponsesPayloadCapabilities = {
  allowsOpenAIServiceTier: boolean;
  allowsResponsesStore: boolean;
  shouldStripResponsesPromptCache: boolean;
  supportsResponsesStoreField: boolean;
  usesKnownNativeOpenAIRoute: boolean;
};

const OPENAI_RESPONSES_PROVIDERS = new Set(["openai", "azure-openai", "azure-openai-responses"]);
const LOCAL_ENDPOINT_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const MODELSTUDIO_NATIVE_BASE_URLS = new Set([
  "https://coding-intl.dashscope.aliyuncs.com/v1",
  "https://coding.dashscope.aliyuncs.com/v1",
  "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
]);
const MOONSHOT_NATIVE_BASE_URLS = new Set([
  "https://api.moonshot.ai/v1",
  "https://api.moonshot.cn/v1",
]);

function normalizeComparableBaseUrl(value: unknown): string | undefined {
  const trimmed = readStringValue(value)?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsedValue = /^[a-z0-9.[\]-]+(?::\d+)?(?:[/?#].*)?$/i.test(trimmed)
    ? `https://${trimmed}`
    : trimmed;
  try {
    const url = new URL(parsedValue);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function resolveUrlHostname(value: unknown): string | undefined {
  const trimmed = readStringValue(value)?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    try {
      return new URL(`https://${trimmed}`).hostname.toLowerCase();
    } catch {
      return undefined;
    }
  }
}

function hostMatchesSuffix(host: string, suffix: string): boolean {
  return suffix.startsWith(".") || suffix.startsWith("-")
    ? host.endsWith(suffix)
    : host === suffix || host.endsWith(`.${suffix}`);
}

function isLocalEndpointHost(host: string): boolean {
  return (
    LOCAL_ENDPOINT_HOSTS.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  );
}

function resolveBundledOpenAIResponsesEndpointClass(
  baseUrl: unknown,
): OpenAIResponsesEndpointClass {
  const trimmed = readStringValue(baseUrl)?.trim();
  if (!trimmed) {
    return "default";
  }
  const host = resolveUrlHostname(trimmed);
  if (!host) {
    return "invalid";
  }
  const comparableBaseUrl = normalizeComparableBaseUrl(trimmed);

  switch (host) {
    case "api.anthropic.com":
      return "anthropic-public";
    case "api.cerebras.ai":
      return "cerebras-native";
    case "llm.chutes.ai":
      return "chutes-native";
    case "api.deepseek.com":
      return "deepseek-native";
    case "api.groq.com":
      return "groq-native";
    case "api.mistral.ai":
      return "mistral-public";
    case "api.openai.com":
      return "openai-public";
    case "chatgpt.com":
      return "openai";
    case "generativelanguage.googleapis.com":
      return "google-generative-ai";
    case "aiplatform.googleapis.com":
      return "google-vertex";
    case "api.x.ai":
      return "xai-native";
    case "api.z.ai":
      return "zai-native";
  }

  if (hostMatchesSuffix(host, ".githubcopilot.com")) {
    return "github-copilot-native";
  }
  if (
    [
      ".openai.azure.com",
      ".cognitiveservices.azure.com",
      ".services.ai.azure.com",
      ".api.cognitive.microsoft.com",
    ].some((suffix) => hostMatchesSuffix(host, suffix))
  ) {
    return "azure-openai";
  }
  if (hostMatchesSuffix(host, "openrouter.ai")) {
    return "openrouter";
  }
  if (hostMatchesSuffix(host, "opencode.ai")) {
    return "opencode-native";
  }
  if (hostMatchesSuffix(host, "-aiplatform.googleapis.com")) {
    return "google-vertex";
  }
  if (comparableBaseUrl && MOONSHOT_NATIVE_BASE_URLS.has(comparableBaseUrl)) {
    return "moonshot-native";
  }
  if (comparableBaseUrl && MODELSTUDIO_NATIVE_BASE_URLS.has(comparableBaseUrl)) {
    return "modelstudio-native";
  }
  if (isLocalEndpointHost(host)) {
    return "local";
  }
  return "custom";
}

function isOpenAIResponsesApi(api: string | undefined): boolean {
  return api !== undefined && OPENAI_RESPONSES_APIS.has(api);
}

function readCompatPayloadBoolean(
  compat: unknown,
  key: "supportsPromptCacheKey" | "supportsStore",
): boolean | undefined {
  if (!compat || typeof compat !== "object") {
    return undefined;
  }
  const value = (compat as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

function resolveOpenAIResponsesPayloadCapabilities(
  model: OpenAIResponsesPayloadModel,
): OpenAIResponsesPayloadCapabilities {
  const provider = normalizeOptionalLowercaseString(model.provider);
  const api = normalizeOptionalLowercaseString(model.api);
  const isOpenAIProvider = provider === "openai";
  const endpointClass = resolveBundledOpenAIResponsesEndpointClass(model.baseUrl);
  const isResponsesApi = isOpenAIResponsesApi(api);
  const usesConfiguredBaseUrl = endpointClass !== "default";
  const usesKnownNativeOpenAIEndpoint =
    endpointClass === "openai-public" ||
    endpointClass === "openai" ||
    endpointClass === "azure-openai";
  const usesKnownNativeOpenAIRoute =
    endpointClass === "default" ? provider === "openai" : usesKnownNativeOpenAIEndpoint;
  const usesExplicitProxyLikeEndpoint = usesConfiguredBaseUrl && !usesKnownNativeOpenAIEndpoint;
  const promptCacheKeySupport = readCompatPayloadBoolean(model.compat, "supportsPromptCacheKey");
  const shouldStripResponsesPromptCache =
    promptCacheKeySupport === true
      ? false
      : promptCacheKeySupport === false
        ? isResponsesApi
        : isResponsesApi && usesExplicitProxyLikeEndpoint;
  const supportsResponsesStoreField =
    readCompatPayloadBoolean(model.compat, "supportsStore") !== false && isResponsesApi;

  return {
    allowsOpenAIServiceTier:
      (provider === "openai" &&
        (api === "openai-responses" || api === "openclaw-openai-responses-transport") &&
        endpointClass === "openai-public") ||
      (isOpenAIProvider &&
        (api === "openai-chatgpt-responses" ||
          api === "openclaw-openai-chatgpt-responses-transport" ||
          api === "openai-responses" ||
          api === "openclaw-openai-responses-transport") &&
        endpointClass === "openai"),
    allowsResponsesStore:
      supportsResponsesStoreField &&
      api !== "openai-chatgpt-responses" &&
      api !== "openclaw-openai-chatgpt-responses-transport" &&
      provider !== undefined &&
      OPENAI_RESPONSES_PROVIDERS.has(provider) &&
      usesKnownNativeOpenAIEndpoint,
    shouldStripResponsesPromptCache,
    supportsResponsesStoreField,
    usesKnownNativeOpenAIRoute,
  };
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    return parseStrictPositiveInteger(value);
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

/** Resolve the server-compaction gate and effective threshold for a Responses route. */
export function resolveOpenAIResponsesServerCompactionPlan(
  model: OpenAIResponsesPayloadModel,
  extraParams?: Record<string, unknown>,
): { enabled: boolean; threshold: number | undefined } {
  const provider = normalizeOptionalLowercaseString(model.provider);
  const allowsResponsesStore =
    resolveOpenAIResponsesPayloadCapabilities(model).allowsResponsesStore;
  const configured = extraParams?.responsesServerCompaction;
  const enabled =
    configured !== false && allowsResponsesStore && (configured === true || provider === "openai");
  return {
    enabled,
    threshold: enabled
      ? (parsePositiveInteger(extraParams?.responsesCompactThreshold) ??
        resolveOpenAIResponsesCompactThreshold(model))
      : undefined,
  };
}

/** Resolve the manual Responses compact-endpoint gate for one route. */
export function resolveOpenAIResponsesCompactEndpointPlan(
  model: OpenAIResponsesPayloadModel,
  extraParams?: Record<string, unknown>,
): { enabled: boolean } {
  const configured = extraParams?.responsesCompactEndpoint;
  const provider = typeof model.provider === "string" ? normalizeProviderId(model.provider) : "";
  return {
    enabled:
      isOpenAIResponsesApi(normalizeOptionalLowercaseString(model.api)) &&
      (configured === true ||
        (configured !== false &&
          (provider === "xai" || provider === "x-ai") &&
          resolveBundledOpenAIResponsesEndpointClass(model.baseUrl) === "xai-native")),
  };
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

/** Strip returned-item metadata rejected by strict Responses-compatible endpoints. */
function stripInputItemStatuses(input: unknown): void {
  if (!Array.isArray(input)) {
    return;
  }
  for (const item of input) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      // Only item-level status is provider metadata. Nested values may be user or tool payloads.
      delete (item as Record<string, unknown>).status;
    }
  }
}

/** Resolve payload mutation policy for one OpenAI Responses-style model endpoint. */
export function resolveOpenAIResponsesPayloadPolicy(
  model: OpenAIResponsesPayloadModel,
  options: OpenAIResponsesPayloadPolicyOptions = {},
): OpenAIResponsesPayloadPolicy {
  const capabilities = resolveOpenAIResponsesPayloadCapabilities(model);
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
  const isResponsesApi = isOpenAIResponsesApi(normalizeOptionalLowercaseString(model.api));
  const shouldStripDisabledReasoningPayload =
    isResponsesApi &&
    (!capabilities.usesKnownNativeOpenAIRoute || !supportsOpenAIReasoningEffort(model, "none"));
  // Strict OpenAI-compatible Responses endpoints reject output-only fields
  // such as `status` on replayed input items. Strip them for non-native routes.
  const shouldStripInputStatus = isResponsesApi && !capabilities.usesKnownNativeOpenAIRoute;
  const serverCompactionPlan = resolveOpenAIResponsesServerCompactionPlan(
    model,
    options.extraParams,
  );

  return {
    allowsServiceTier: capabilities.allowsOpenAIServiceTier,
    compactThreshold: serverCompactionPlan.threshold,
    explicitStore,
    shouldStripDisabledReasoningPayload,
    shouldStripInputStatus,
    shouldStripPromptCache:
      options.enablePromptCacheStripping === true && capabilities.shouldStripResponsesPromptCache,
    shouldStripStore:
      explicitStore !== true &&
      readCompatPayloadBoolean(model.compat, "supportsStore") === false &&
      isResponsesApi,
    useServerCompaction: options.enableServerCompaction === true && serverCompactionPlan.enabled,
  };
}

/** Mutate a Responses request payload according to the resolved endpoint policy. */
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
  if (
    policy.useServerCompaction &&
    policy.compactThreshold !== undefined &&
    payloadObj.context_management === undefined
  ) {
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
  if (policy.shouldStripInputStatus) {
    stripInputItemStatuses(payloadObj.input);
  }
}
