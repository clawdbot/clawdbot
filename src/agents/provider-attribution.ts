import { loadPluginManifestRegistryForPluginRegistry } from "../plugins/plugin-registry.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import type { RuntimeVersionEnv } from "../version.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { normalizeProviderId } from "./provider-id.js";

export type ProviderAttributionVerification =
  | "vendor-documented"
  | "vendor-hidden-api-spec"
  | "vendor-sdk-hook-only"
  | "internal-runtime";

export type ProviderAttributionHook =
  | "request-headers"
  | "default-headers"
  | "user-agent-extra"
  | "custom-user-agent";

export type ProviderAttributionPolicy = {
  provider: string;
  enabledByDefault: boolean;
  verification: ProviderAttributionVerification;
  hook?: ProviderAttributionHook;
  docsUrl?: string;
  reviewNote?: string;
  product: string;
  version: string;
  headers?: Record<string, string>;
};

export type ProviderAttributionIdentity = Pick<ProviderAttributionPolicy, "product" | "version">;

export type ProviderRequestTransport = "stream" | "websocket" | "http" | "media-understanding";
export type ProviderRequestCapability = "llm" | "audio" | "image" | "video" | "other";

export type ProviderEndpointClass =
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
  | "openai-codex"
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

export type ProviderEndpointResolution = {
  endpointClass: ProviderEndpointClass;
  hostname?: string;
  googleVertexRegion?: string;
};

export type ProviderRequestPolicyInput = {
  provider?: string | null;
  api?: string | null;
  baseUrl?: string | null;
  transport?: ProviderRequestTransport;
  capability?: ProviderRequestCapability;
};

export type ProviderRequestPolicyResolution = {
  provider?: string;
  policy?: ProviderAttributionPolicy;
  endpointClass: ProviderEndpointClass;
  usesConfiguredBaseUrl: boolean;
  knownProviderFamily: string;
  attributionProvider?: string;
  attributionHeaders?: Record<string, string>;
  allowsHiddenAttribution: boolean;
  usesKnownNativeOpenAIEndpoint: boolean;
  usesKnownNativeOpenAIRoute: boolean;
  usesVerifiedOpenAIAttributionHost: boolean;
  usesExplicitProxyLikeEndpoint: boolean;
};

export type ProviderRequestCapabilitiesInput = ProviderRequestPolicyInput & {
  modelId?: string | null;
  compat?: unknown;
};

export type ProviderRequestCompatibilityFamily = "moonshot";

export type ProviderRequestCapabilities = ProviderRequestPolicyResolution & {
  isKnownNativeEndpoint: boolean;
  allowsOpenAIServiceTier: boolean;
  supportsOpenAIReasoningCompatPayload: boolean;
  allowsAnthropicServiceTier: boolean;
  supportsResponsesStoreField: boolean;
  allowsResponsesStore: boolean;
  shouldStripResponsesPromptCache: boolean;
  supportsNativeStreamingUsageCompat: boolean;
  compatibilityFamily?: ProviderRequestCompatibilityFamily;
};

function readCompatBoolean(
  compat: unknown,
  key: "supportsStore" | "supportsPromptCacheKey",
): boolean | undefined {
  if (!compat || typeof compat !== "object") {
    return undefined;
  }
  const value = (compat as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

const OPENCLAW_ATTRIBUTION_PRODUCT = "OpenClaw";
const OPENCLAW_ATTRIBUTION_ORIGINATOR = "openclaw";

const LOCAL_ENDPOINT_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const MOONSHOT_NATIVE_BASE_URLS = new Set([
  "https://api.moonshot.ai/v1",
  "https://api.moonshot.cn/v1",
]);
const MODELSTUDIO_NATIVE_BASE_URLS = new Set([
  "https://coding-intl.dashscope.aliyuncs.com/v1",
  "https://coding.dashscope.aliyuncs.com/v1",
  "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
]);
const OPENAI_RESPONSES_APIS = new Set([
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
]);
const OPENAI_RESPONSES_PROVIDERS = new Set(["openai", "azure-openai", "azure-openai-responses"]);
const MOONSHOT_COMPAT_PROVIDERS = new Set(["moonshot", "kimi"]);
const MANIFEST_PROVIDER_ENDPOINT_CLASSES = new Set<ProviderEndpointClass>(["xai-native"]);
type ManifestProviderEndpointCacheEntry = {
  endpointClass: ProviderEndpointClass;
  hosts: readonly string[];
  normalizedBaseUrls: readonly string[];
};
let manifestProviderEndpointCache: ManifestProviderEndpointCacheEntry[] | null = null;

function formatOpenClawUserAgent(version: string): string {
  return `${OPENCLAW_ATTRIBUTION_ORIGINATOR}/${version}`;
}

function tryParseHostname(value: string): string | undefined {
  try {
    return normalizeOptionalLowercaseString(new URL(value).hostname);
  } catch {
    return undefined;
  }
}

function isSchemelessHostnameCandidate(value: string): boolean {
  return /^[a-z0-9.[\]-]+(?::\d+)?(?:[/?#].*)?$/i.test(value);
}

function resolveUrlHostname(value: unknown): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const parsedHostname = tryParseHostname(trimmed);
  if (parsedHostname) {
    return parsedHostname;
  }
  if (!isSchemelessHostnameCandidate(trimmed)) {
    return undefined;
  }
  return tryParseHostname(`https://${trimmed}`);
}

function normalizeComparableBaseUrl(value: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }

  const parsedValue =
    tryParseHostname(trimmed) || !isSchemelessHostnameCandidate(trimmed)
      ? trimmed
      : `https://${trimmed}`;
  try {
    const url = new URL(parsedValue);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    url.hash = "";
    url.search = "";
    return normalizeOptionalLowercaseString(url.toString().replace(/\/+$/, ""));
  } catch {
    return undefined;
  }
}

function isManifestProviderEndpointClass(value: string): value is ProviderEndpointClass {
  return MANIFEST_PROVIDER_ENDPOINT_CLASSES.has(value as ProviderEndpointClass);
}

function loadManifestProviderEndpointCache(): ManifestProviderEndpointCacheEntry[] {
  if (!manifestProviderEndpointCache) {
    const registry = loadPluginManifestRegistryForPluginRegistry({ includeDisabled: true });
    const entries: ManifestProviderEndpointCacheEntry[] = [];
    for (const plugin of registry.plugins) {
      for (const endpoint of plugin.providerEndpoints ?? []) {
        if (!isManifestProviderEndpointClass(endpoint.endpointClass)) {
          continue;
        }
        entries.push({
          endpointClass: endpoint.endpointClass,
          hosts: (endpoint.hosts ?? []).map((host) => host.toLowerCase()),
          normalizedBaseUrls: (endpoint.baseUrls ?? [])
            .map((baseUrl) => normalizeComparableBaseUrl(baseUrl))
            .filter((baseUrl): baseUrl is string => baseUrl !== undefined),
        });
      }
    }
    manifestProviderEndpointCache = entries;
  }
  return manifestProviderEndpointCache;
}

function resolveManifestProviderEndpoint(params: {
  host: string;
  normalizedBaseUrl?: string;
}): ProviderEndpointResolution | undefined {
  for (const endpoint of loadManifestProviderEndpointCache()) {
    if (endpoint.hosts.includes(params.host)) {
      return { endpointClass: endpoint.endpointClass, hostname: params.host };
    }
    if (
      params.normalizedBaseUrl &&
      endpoint.normalizedBaseUrls.includes(params.normalizedBaseUrl)
    ) {
      return { endpointClass: endpoint.endpointClass, hostname: params.host };
    }
  }
  return undefined;
}

function isLocalEndpointHost(host: string): boolean {
  return (
    LOCAL_ENDPOINT_HOSTS.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  );
}

export function resolveProviderEndpoint(
  baseUrl: string | null | undefined,
): ProviderEndpointResolution {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return { endpointClass: "default" };
  }

  const host = resolveUrlHostname(baseUrl);
  if (!host) {
    return { endpointClass: "invalid" };
  }
  const normalizedBaseUrl = normalizeComparableBaseUrl(baseUrl);
  if (normalizedBaseUrl && MOONSHOT_NATIVE_BASE_URLS.has(normalizedBaseUrl)) {
    return { endpointClass: "moonshot-native", hostname: host };
  }
  if (normalizedBaseUrl && MODELSTUDIO_NATIVE_BASE_URLS.has(normalizedBaseUrl)) {
    return { endpointClass: "modelstudio-native", hostname: host };
  }
  if (host === "api.openai.com") {
    return { endpointClass: "openai-public", hostname: host };
  }
  if (host === "api.anthropic.com") {
    return { endpointClass: "anthropic-public", hostname: host };
  }
  if (host === "api.mistral.ai") {
    return { endpointClass: "mistral-public", hostname: host };
  }
  if (host === "api.cerebras.ai") {
    return { endpointClass: "cerebras-native", hostname: host };
  }
  if (host === "llm.chutes.ai") {
    return { endpointClass: "chutes-native", hostname: host };
  }
  if (host === "api.deepseek.com") {
    return { endpointClass: "deepseek-native", hostname: host };
  }
  if (host.endsWith(".githubcopilot.com")) {
    return { endpointClass: "github-copilot-native", hostname: host };
  }
  if (host === "api.groq.com") {
    return { endpointClass: "groq-native", hostname: host };
  }
  if (host === "chatgpt.com") {
    return { endpointClass: "openai-codex", hostname: host };
  }
  if (host === "opencode.ai" || host.endsWith(".opencode.ai")) {
    return { endpointClass: "opencode-native", hostname: host };
  }
  if (host === "openrouter.ai" || host.endsWith(".openrouter.ai")) {
    return { endpointClass: "openrouter", hostname: host };
  }
  if (host === "api.z.ai") {
    return { endpointClass: "zai-native", hostname: host };
  }
  if (host.endsWith(".openai.azure.com")) {
    return { endpointClass: "azure-openai", hostname: host };
  }
  if (host === "generativelanguage.googleapis.com") {
    return { endpointClass: "google-generative-ai", hostname: host };
  }
  if (host === "aiplatform.googleapis.com") {
    return {
      endpointClass: "google-vertex",
      hostname: host,
      googleVertexRegion: "global",
    };
  }
  const googleVertexHost = /^([a-z0-9-]+)-aiplatform\.googleapis\.com$/.exec(host);
  if (googleVertexHost) {
    return {
      endpointClass: "google-vertex",
      hostname: host,
      googleVertexRegion: googleVertexHost[1],
    };
  }
  const manifestEndpoint = resolveManifestProviderEndpoint({ host, normalizedBaseUrl });
  if (manifestEndpoint) {
    return manifestEndpoint;
  }
  if (isLocalEndpointHost(host)) {
    return { endpointClass: "local", hostname: host };
  }
  return { endpointClass: "custom", hostname: host };
}

function resolveKnownProviderFamily(provider: string | undefined): string {
  switch (provider) {
    case "openai":
    case "openai-codex":
    case "azure-openai":
    case "azure-openai-responses":
      return "openai-family";
    case "openrouter":
      return "openrouter";
    case "anthropic":
      return "anthropic";
    case "chutes":
      return "chutes";
    case "deepseek":
      return "deepseek";
    case "google":
      return "google";
    case "xai":
      return "xai";
    case "zai":
      return "zai";
    case "moonshot":
    case "kimi":
      return "moonshot";
    case "qwen":
    case "qwencloud":
    case "modelstudio":
    case "dashscope":
      return "modelstudio";
    case "github-copilot":
      return "github-copilot";
    case "groq":
      return "groq";
    case "mistral":
      return "mistral";
    case "together":
      return "together";
    default:
      return provider || "unknown";
  }
}

export function isOpenAIResponsesApi(api: string | null | undefined): boolean {
  const normalizedApi = normalizeOptionalLowercaseString(api);
  return normalizedApi !== undefined && OPENAI_RESPONSES_APIS.has(normalizedApi);
}

export function resolveProviderAttributionIdentity(
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
): ProviderAttributionIdentity {
  return {
    product: OPENCLAW_ATTRIBUTION_PRODUCT,
    version: resolveRuntimeServiceVersion(env),
  };
}

function buildOpenRouterAttributionPolicy(
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
): ProviderAttributionPolicy {
  const identity = resolveProviderAttributionIdentity(env);
  return {
    provider: "openrouter",
    enabledByDefault: true,
    verification: "vendor-documented",
    hook: "request-headers",
    docsUrl: "https://openrouter.ai/docs/app-attribution",
    reviewNote: "Documented app attribution headers. Verified in OpenClaw runtime wrapper.",
    ...identity,
    headers: {
      "HTTP-Referer": "https://openclaw.ai",
      "X-OpenRouter-Title": identity.product,
      "X-OpenRouter-Categories": "cli-agent",
    },
  };
}

function buildOpenAIAttributionPolicy(
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
): ProviderAttributionPolicy {
  const identity = resolveProviderAttributionIdentity(env);
  return {
    provider: "openai",
    enabledByDefault: true,
    verification: "vendor-hidden-api-spec",
    hook: "request-headers",
    reviewNote:
      "OpenAI native traffic supports hidden originator/User-Agent attribution. Verified against the Codex wire contract.",
    ...identity,
    headers: {
      originator: OPENCLAW_ATTRIBUTION_ORIGINATOR,
      version: identity.version,
      "User-Agent": formatOpenClawUserAgent(identity.version),
    },
  };
}

function buildOpenAICodexAttributionPolicy(
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
): ProviderAttributionPolicy {
  const identity = resolveProviderAttributionIdentity(env);
  return {
    provider: "openai-codex",
    enabledByDefault: true,
    verification: "vendor-hidden-api-spec",
    hook: "request-headers",
    reviewNote:
      "OpenAI Codex ChatGPT-backed traffic supports the same hidden originator/User-Agent attribution contract.",
    ...identity,
    headers: {
      originator: OPENCLAW_ATTRIBUTION_ORIGINATOR,
      version: identity.version,
      "User-Agent": formatOpenClawUserAgent(identity.version),
    },
  };
}

function buildSdkHookOnlyPolicy(
  provider: string,
  hook: ProviderAttributionHook,
  reviewNote: string,
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
): ProviderAttributionPolicy {
  return {
    provider,
    enabledByDefault: false,
    verification: "vendor-sdk-hook-only",
    hook,
    reviewNote,
    ...resolveProviderAttributionIdentity(env),
  };
}

export function listProviderAttributionPolicies(
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
): ProviderAttributionPolicy[] {
  return [
    buildOpenRouterAttributionPolicy(env),
    buildOpenAIAttributionPolicy(env),
    buildOpenAICodexAttributionPolicy(env),
    buildSdkHookOnlyPolicy(
      "anthropic",
      "default-headers",
      "Anthropic JS SDK exposes defaultHeaders, but app attribution is not yet verified.",
      env,
    ),
    buildSdkHookOnlyPolicy(
      "google",
      "user-agent-extra",
      "Google GenAI JS SDK exposes userAgentExtra/httpOptions, but provider-side attribution is not yet verified.",
      env,
    ),
    buildSdkHookOnlyPolicy(
      "groq",
      "default-headers",
      "Groq JS SDK exposes defaultHeaders, but app attribution is not yet verified.",
      env,
    ),
    buildSdkHookOnlyPolicy(
      "mistral",
      "custom-user-agent",
      "Mistral JS SDK exposes a custom userAgent option, but app attribution is not yet verified.",
      env,
    ),
    buildSdkHookOnlyPolicy(
      "together",
      "default-headers",
      "Together JS SDK exposes defaultHeaders, but app attribution is not yet verified.",
      env,
    ),
  ];
}

export function resolveProviderAttributionPolicy(
  provider?: string | null,
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
): ProviderAttributionPolicy | undefined {
  const normalized = normalizeProviderId(provider ?? "");
  return listProviderAttributionPolicies(env).find((policy) => policy.provider === normalized);
}

export function resolveProviderAttributionHeaders(
  provider?: string | null,
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
): Record<string, string> | undefined {
  const policy = resolveProviderAttributionPolicy(provider, env);
  if (!policy?.enabledByDefault) {
    return undefined;
  }
  return policy.headers;
}

export function resolveProviderRequestPolicy(
  input: ProviderRequestPolicyInput,
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
): ProviderRequestPolicyResolution {
  const provider = normalizeProviderId(input.provider ?? "");
  const policy = resolveProviderAttributionPolicy(provider, env);
  const endpointResolution = resolveProviderEndpoint(input.baseUrl);
  const endpointClass = endpointResolution.endpointClass;
  const api = normalizeOptionalLowercaseString(input.api);
  const usesConfiguredBaseUrl = endpointClass !== "default";
  const usesKnownNativeOpenAIEndpoint =
    endpointClass === "openai-public" ||
    endpointClass === "openai-codex" ||
    endpointClass === "azure-openai";
  const usesOpenAIPublicAttributionHost = endpointClass === "openai-public";
  const usesOpenAICodexAttributionHost = endpointClass === "openai-codex";
  const usesVerifiedOpenAIAttributionHost =
    usesOpenAIPublicAttributionHost || usesOpenAICodexAttributionHost;
  const usesExplicitProxyLikeEndpoint = usesConfiguredBaseUrl && !usesKnownNativeOpenAIEndpoint;

  let attributionProvider: string | undefined;
  if (
    provider === "openai" &&
    (api === "openai-completions" ||
      api === "openai-responses" ||
      (input.capability === "audio" && api === "openai-audio-transcriptions")) &&
    usesOpenAIPublicAttributionHost
  ) {
    attributionProvider = "openai";
  } else if (
    provider === "openai-codex" &&
    (api === "openai-codex-responses" || api === "openai-responses") &&
    usesOpenAICodexAttributionHost
  ) {
    attributionProvider = "openai-codex";
  } else if (provider === "openrouter" && policy?.enabledByDefault) {
    // OpenRouter attribution is documented, but only apply it to known
    // OpenRouter endpoints or the default (unset) baseUrl path.
    if (endpointClass === "openrouter" || endpointClass === "default") {
      attributionProvider = "openrouter";
    }
  }

  const attributionHeaders = attributionProvider
    ? resolveProviderAttributionHeaders(attributionProvider, env)
    : undefined;

  return {
    provider: provider || undefined,
    policy,
    endpointClass,
    usesConfiguredBaseUrl,
    knownProviderFamily: resolveKnownProviderFamily(provider || undefined),
    attributionProvider,
    attributionHeaders,
    allowsHiddenAttribution:
      attributionProvider !== undefined && policy?.verification === "vendor-hidden-api-spec",
    usesKnownNativeOpenAIEndpoint,
    usesKnownNativeOpenAIRoute:
      endpointClass === "default" ? provider === "openai" : usesKnownNativeOpenAIEndpoint,
    usesVerifiedOpenAIAttributionHost,
    usesExplicitProxyLikeEndpoint,
  };
}

export function resolveProviderRequestAttributionHeaders(
  input: ProviderRequestPolicyInput,
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
): Record<string, string> | undefined {
  return resolveProviderRequestPolicy(input, env).attributionHeaders;
}

export function resolveProviderRequestCapabilities(
  input: ProviderRequestCapabilitiesInput,
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
): ProviderRequestCapabilities {
  const policy = resolveProviderRequestPolicy(input, env);
  const provider = policy.provider;
  const api = normalizeOptionalLowercaseString(input.api);
  const endpointClass = policy.endpointClass;
  const isKnownNativeEndpoint =
    endpointClass === "anthropic-public" ||
    endpointClass === "cerebras-native" ||
    endpointClass === "chutes-native" ||
    endpointClass === "deepseek-native" ||
    endpointClass === "github-copilot-native" ||
    endpointClass === "groq-native" ||
    endpointClass === "mistral-public" ||
    endpointClass === "moonshot-native" ||
    endpointClass === "modelstudio-native" ||
    endpointClass === "openai-public" ||
    endpointClass === "openai-codex" ||
    endpointClass === "opencode-native" ||
    endpointClass === "azure-openai" ||
    endpointClass === "openrouter" ||
    endpointClass === "xai-native" ||
    endpointClass === "zai-native" ||
    endpointClass === "google-generative-ai" ||
    endpointClass === "google-vertex";

  let compatibilityFamily: ProviderRequestCompatibilityFamily | undefined;
  if (provider && MOONSHOT_COMPAT_PROVIDERS.has(provider)) {
    compatibilityFamily = "moonshot";
  }

  const isResponsesApi = isOpenAIResponsesApi(api);
  const promptCacheKeySupport = readCompatBoolean(input.compat, "supportsPromptCacheKey");
  // Default strip behavior (proxy-like endpoints with responses APIs) is
  // preserved as a safety net for providers that reject prompt_cache_key,
  // see #48155 (Volcano Engine DeepSeek). Operators running their payload
  // through an OpenAI-compatible proxy known to forward the field
  // (CLIProxy, LiteLLM, etc.) can opt out via compat.supportsPromptCacheKey
  // to recover prompt caching; providers known to reject the field can
  // force the strip with compat.supportsPromptCacheKey = false even on
  // native endpoints.
  const shouldStripResponsesPromptCache =
    promptCacheKeySupport === true
      ? false
      : promptCacheKeySupport === false
        ? isResponsesApi
        : isResponsesApi && policy.usesExplicitProxyLikeEndpoint;

  return {
    ...policy,
    isKnownNativeEndpoint,
    allowsOpenAIServiceTier:
      (provider === "openai" && api === "openai-responses" && endpointClass === "openai-public") ||
      (provider === "openai-codex" &&
        (api === "openai-codex-responses" || api === "openai-responses") &&
        endpointClass === "openai-codex"),
    supportsOpenAIReasoningCompatPayload:
      provider !== undefined &&
      api !== undefined &&
      !policy.usesExplicitProxyLikeEndpoint &&
      (provider === "openai" ||
        provider === "openai-codex" ||
        provider === "azure-openai" ||
        provider === "azure-openai-responses") &&
      (api === "openai-completions" ||
        api === "openai-responses" ||
        api === "openai-codex-responses" ||
        api === "azure-openai-responses"),
    allowsAnthropicServiceTier:
      provider === "anthropic" &&
      api === "anthropic-messages" &&
      (endpointClass === "default" || endpointClass === "anthropic-public"),
    // This is intentionally the gate for emitting `store: false` on Responses
    // transports, not just a statement about vendor support in the abstract.
    supportsResponsesStoreField:
      readCompatBoolean(input.compat, "supportsStore") !== false && isResponsesApi,
    allowsResponsesStore:
      readCompatBoolean(input.compat, "supportsStore") !== false &&
      provider !== undefined &&
      isResponsesApi &&
      OPENAI_RESPONSES_PROVIDERS.has(provider) &&
      policy.usesKnownNativeOpenAIEndpoint,
    shouldStripResponsesPromptCache,
    // Native endpoint class is the real signal here. Users can point a generic
    // provider key at Moonshot or DashScope and still need streaming usage.
    supportsNativeStreamingUsageCompat:
      endpointClass === "moonshot-native" || endpointClass === "modelstudio-native",
    compatibilityFamily,
  };
}

function describeProviderRequestRoutingPolicy(
  policy: ProviderRequestPolicyResolution,
): "hidden" | "documented" | "sdk-hook-only" | "none" {
  if (!policy.attributionProvider) {
    return "none";
  }
  switch (policy.policy?.verification) {
    case "vendor-hidden-api-spec":
      return "hidden";
    case "vendor-documented":
      return "documented";
    case "vendor-sdk-hook-only":
      return "sdk-hook-only";
    default:
      return "none";
  }
}

function describeProviderRequestRouteClass(
  policy: ProviderRequestPolicyResolution,
): "default" | "native" | "proxy-like" | "local" | "invalid" {
  if (policy.endpointClass === "default") {
    return "default";
  }
  if (policy.endpointClass === "invalid") {
    return "invalid";
  }
  if (policy.endpointClass === "local") {
    return "local";
  }
  if (policy.endpointClass === "custom" || policy.endpointClass === "openrouter") {
    return "proxy-like";
  }
  return "native";
}

export function describeProviderRequestRoutingSummary(
  input: ProviderRequestPolicyInput,
  env: RuntimeVersionEnv = process.env as RuntimeVersionEnv,
): string {
  const policy = resolveProviderRequestPolicy(input, env);
  const api = normalizeOptionalLowercaseString(input.api) ?? "unknown";
  const provider = policy.provider ?? "unknown";
  const routeClass = describeProviderRequestRouteClass(policy);
  const routingPolicy = describeProviderRequestRoutingPolicy(policy);

  return [
    `provider=${provider}`,
    `api=${api}`,
    `endpoint=${policy.endpointClass}`,
    `route=${routeClass}`,
    `policy=${routingPolicy}`,
  ].join(" ");
}
