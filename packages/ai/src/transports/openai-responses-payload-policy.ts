import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
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
import { parsePositiveInteger } from "./transport-utils.js";

type OpenAIResponsesPayloadModel = {
  api?: unknown;
  baseUrl?: unknown;
  id?: unknown;
  provider?: unknown;
  contextTokens?: unknown;
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
  explicitContinuationOptIn: boolean;
  explicitStore: boolean | undefined;
  shouldStripDisabledReasoningPayload: boolean;
  shouldStripInputStatus: boolean;
  shouldStripPromptCache: boolean;
  shouldStripStore: boolean;
  useServerCompaction: boolean;
  usesInstructionsField: boolean;
};

type OpenAIResponsesPayloadCapabilities = {
  allowsOpenAIServiceTier: boolean;
  allowsResponsesStore: boolean;
  explicitContinuationOptIn: boolean;
  shouldStripResponsesPromptCache: boolean;
  supportsResponsesStoreField: boolean;
  usesKnownNativeOpenAIRoute: boolean;
  usesVerifiedInstructionsEndpoint: boolean;
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
  key:
    | "supportsInstructions"
    | "supportsPromptCacheKey"
    | "supportsResponsesContinuation"
    | "supportsStore",
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
  // Recognizing a hostname (routing it to a named endpointClass) is not the
  // same as having confirmed that host's Responses API honors `instructions`
  // -- OpenClaw bundles many named classes (Cerebras, Groq, Mistral,
  // OpenCode, GitHub Copilot, ...) purely for SSRF/base-URL matching and
  // other unrelated capability detection, with no contract proof either way
  // for `instructions` specifically. Only two routes are actually verified:
  // native OpenAI (definitionally, it's OpenAI's own API) and xAI's main
  // route (confirmed via direct testing -- see the xAI compact-endpoint
  // opt-out carve-out below, discovered by testing the real API). Every
  // other named class defaults the same as an explicit custom/local proxy;
  // `compat.supportsInstructions: true` opts a confirmed-working route in.
  // Deliberately narrower than usesKnownNativeOpenAIRoute (used above for
  // reasoning/service-tier/input-status policy): that boolean also covers
  // azure-openai, which has never been verified for `instructions`
  // specifically -- Azure mirrors OpenAI's API closely, but "closely" isn't
  // a contract, and this file's whole point is not assuming one without
  // evidence.
  const usesVerifiedNativeOpenAIRoute =
    endpointClass === "default"
      ? provider === "openai"
      : endpointClass === "openai-public" || endpointClass === "openai";
  const usesVerifiedInstructionsEndpoint =
    usesVerifiedNativeOpenAIRoute || endpointClass === "xai-native";
  const promptCacheKeySupport = readCompatPayloadBoolean(model.compat, "supportsPromptCacheKey");
  const shouldStripResponsesPromptCache =
    promptCacheKeySupport === true
      ? false
      : promptCacheKeySupport === false
        ? isResponsesApi
        : isResponsesApi && usesExplicitProxyLikeEndpoint;
  const supportsResponsesStoreField =
    readCompatPayloadBoolean(model.compat, "supportsStore") !== false && isResponsesApi;
  // Provider-owned opt-in for a custom/proxy OpenAI-Responses-compatible
  // endpoint (self-hosted router, gateway, etc.): the endpoint class itself
  // carries no trust signal, so eligibility here comes entirely from an
  // operator explicitly confirming, per model, that the backend correctly
  // resolves `previous_response_id` and persists `store: true` turns.
  // Scoped to the custom `openai-responses` route only -- not the broader
  // isResponsesApi predicate, which also matches `openai-chatgpt-responses`.
  // ChatGPT/Codex deliberately stays `store: false` (see allowsResponsesStore
  // below); this opt-in must never be able to flip that contract for an
  // operator who sets the compat flag on a ChatGPT/Codex-routed model.
  // Azure is excluded: azure-openai-responses.ts hardcodes `store: false`
  // downstream regardless, so opting in there would be a no-op.
  const explicitContinuationOptIn =
    (api === "openai-responses" || api === "openclaw-openai-responses-transport") &&
    supportsResponsesStoreField &&
    provider !== "azure-openai" &&
    provider !== "azure-openai-responses" &&
    readCompatPayloadBoolean(model.compat, "supportsResponsesContinuation") === true;

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
    explicitContinuationOptIn,
    shouldStripResponsesPromptCache,
    supportsResponsesStoreField,
    usesKnownNativeOpenAIRoute,
    usesVerifiedInstructionsEndpoint,
  };
}

function resolveOpenAIResponsesCompactThreshold(model: {
  contextTokens?: unknown;
  contextWindow?: unknown;
}): number {
  const contextTokens = parsePositiveInteger(model.contextTokens);
  const contextWindow = parsePositiveInteger(model.contextWindow);
  const effectiveBudget =
    contextTokens && contextWindow
      ? Math.min(contextTokens, contextWindow)
      : contextTokens || contextWindow;
  if (effectiveBudget) {
    return Math.max(1_000, Math.floor(effectiveBudget * 0.7));
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
  // A continuation-eligible native OpenAI connection needs store:true to get
  // a previous_response_id back — "disable" mode still means "force store
  // off by default", but that default is specifically what continuation
  // eligibility overrides, same as "provider-policy" mode. Without this,
  // buildOpenAIResponsesParams (the only shipped request builder for this
  // transport) always resolves this policy with storeMode:"disable", so
  // params.store is never true and the HTTP continuation claim guard in
  // openai-responses-client.ts (which requires params.store === true) never
  // passes, regardless of eligibility.
  const explicitStore =
    storeMode === "preserve"
      ? undefined
      : storeMode === "disable"
        ? capabilities.allowsResponsesStore || capabilities.explicitContinuationOptIn
          ? true
          : capabilities.supportsResponsesStoreField
            ? false
            : undefined
        : capabilities.allowsResponsesStore || capabilities.explicitContinuationOptIn
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
  // Defaults on only for the two routes actually confirmed to honor
  // `instructions` (see usesVerifiedInstructionsEndpoint above: native
  // OpenAI, and xAI's main route by direct test). Every other route --
  // including bundled-but-unverified named classes and arbitrary
  // custom/local proxies -- defaults off: HTTP continuation is unreachable
  // there anyway (openai-responses-websocket.ts requires the exact native
  // OpenAI base URL), so there is nothing to gain from `instructions` and
  // real risk of an unconfirmed route silently dropping the field along
  // with the system prompt. `compat.supportsInstructions` always overrides
  // the default in either direction -- explicit `false` opts a verified
  // route out (confirmed necessary for xAI's compact endpoint specifically);
  // explicit `true` opts any other route in once confirmed.
  const instructionsCompat = readCompatPayloadBoolean(model.compat, "supportsInstructions");
  const usesInstructionsField = instructionsCompat ?? capabilities.usesVerifiedInstructionsEndpoint;

  return {
    allowsServiceTier: capabilities.allowsOpenAIServiceTier,
    compactThreshold: serverCompactionPlan.threshold,
    explicitContinuationOptIn: capabilities.explicitContinuationOptIn,
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
    usesInstructionsField,
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
