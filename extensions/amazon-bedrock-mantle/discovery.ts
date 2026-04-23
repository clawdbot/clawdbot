import { createSubsystemLogger } from "openclaw/plugin-sdk/core";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

const log = createSubsystemLogger("bedrock-mantle-discovery");

const DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const DEFAULT_CONTEXT_WINDOW = 32000;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_REFRESH_INTERVAL_SECONDS = 3600; // 1 hour
export const MANTLE_IAM_TOKEN_MARKER = "__amazon_bedrock_mantle_iam__";

// ---------------------------------------------------------------------------
// Mantle region & endpoint helpers
// ---------------------------------------------------------------------------

const MANTLE_SUPPORTED_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "ap-northeast-1",
  "ap-south-1",
  "ap-southeast-3",
  "eu-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-south-1",
  "eu-north-1",
  "sa-east-1",
] as const;

function mantleEndpoint(region: string): string {
  return `https://bedrock-mantle.${region}.api.aws`;
}

function isSupportedRegion(region: string): boolean {
  return (MANTLE_SUPPORTED_REGIONS as readonly string[]).includes(region);
}

// ---------------------------------------------------------------------------
// Bearer token resolution
// ---------------------------------------------------------------------------

export type MantleBearerTokenProvider = () => Promise<string>;
export type MantleBearerTokenProviderFactory = (opts?: {
  region?: string;
  expiresInSeconds?: number;
}) => MantleBearerTokenProvider;

async function loadMantleBearerTokenProviderFactory(): Promise<MantleBearerTokenProviderFactory> {
  const { getTokenProvider } = (await import("@aws/bedrock-token-generator")) as {
    getTokenProvider: MantleBearerTokenProviderFactory;
  };
  return getTokenProvider;
}

/**
 * Resolve a bearer token for Mantle authentication.
 *
 * Returns the value of AWS_BEARER_TOKEN_BEDROCK if set, undefined otherwise.
 * When no explicit token is set, `resolveImplicitMantleProvider` will attempt
 * to generate one from IAM credentials via `@aws/bedrock-token-generator`.
 */
export function resolveMantleBearerToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicitToken = env.AWS_BEARER_TOKEN_BEDROCK?.trim();
  if (explicitToken) {
    return explicitToken;
  }
  return undefined;
}

/** Token cache for IAM-derived bearer tokens, keyed by region. */
const iamTokenCache = new Map<string, { token: string; expiresAt: number }>();
const IAM_TOKEN_TTL_MS = 7200_000; // Matches the 2h token lifetime we request below.

function resolveMantleRegion(env: NodeJS.ProcessEnv): string {
  return env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1";
}

function getCachedIamTokenEntry(
  region: string,
  now: number = Date.now(),
): { token: string; expiresAt: number } | undefined {
  const cached = iamTokenCache.get(region);
  if (cached && cached.expiresAt > now) {
    return cached;
  }
  return undefined;
}

/**
 * Generate a bearer token from IAM credentials using `@aws/bedrock-token-generator`.
 *
 * Uses the AWS default credential chain (instance roles, SSO, access keys, EKS IRSA).
 * Returns undefined if the package is not installed or credentials are unavailable.
 */
export async function generateBearerTokenFromIam(params: {
  region: string;
  now?: () => number;
  tokenProviderFactory?: MantleBearerTokenProviderFactory;
}): Promise<string | undefined> {
  const now = params.now?.() ?? Date.now();
  const cached = getCachedIamTokenEntry(params.region, now);

  if (cached) {
    return cached.token;
  }

  try {
    const getTokenProvider =
      params.tokenProviderFactory ?? (await loadMantleBearerTokenProviderFactory());
    const token = await getTokenProvider({
      region: params.region,
      expiresInSeconds: 7200, // 2 hours
    })();
    iamTokenCache.set(params.region, { token, expiresAt: now + IAM_TOKEN_TTL_MS });
    return token;
  } catch (error) {
    log.debug?.("Mantle IAM token generation unavailable", {
      region: params.region,
      error: formatErrorMessage(error),
    });
    return undefined;
  }
}

/**
 * Read a cached IAM bearer token for the given region (sync, no generation).
 *
 * Returns the token if it exists and has not expired, undefined otherwise.
 * Used by Mantle runtime auth and tests to inspect the current cache.
 */
export function getCachedIamToken(region: string): string | undefined {
  return getCachedIamTokenEntry(region)?.token;
}

export async function resolveMantleRuntimeBearerToken(params: {
  apiKey: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  tokenProviderFactory?: MantleBearerTokenProviderFactory;
}): Promise<{ apiKey: string; expiresAt?: number } | undefined> {
  if (params.apiKey !== MANTLE_IAM_TOKEN_MARKER) {
    return { apiKey: params.apiKey };
  }
  const now = params.now?.() ?? Date.now();
  const region = resolveMantleRegion(params.env ?? process.env);
  const cached = getCachedIamTokenEntry(region, now);
  if (cached) {
    return {
      apiKey: cached.token,
      expiresAt: cached.expiresAt,
    };
  }
  const token = await generateBearerTokenFromIam({
    region,
    now: params.now,
    tokenProviderFactory: params.tokenProviderFactory,
  });
  if (!token) {
    return undefined;
  }
  const refreshed = getCachedIamTokenEntry(region, now);
  return {
    apiKey: refreshed?.token ?? token,
    expiresAt: refreshed?.expiresAt ?? now + IAM_TOKEN_TTL_MS,
  };
}
/** Reset the IAM token cache (for testing). */
export function resetIamTokenCacheForTest(): void {
  iamTokenCache.clear();
}

// ---------------------------------------------------------------------------
// OpenAI-format model list response
// ---------------------------------------------------------------------------

interface OpenAIModelEntry {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
}

interface OpenAIModelsResponse {
  data?: OpenAIModelEntry[];
  object?: string;
}

// ---------------------------------------------------------------------------
// Reasoning heuristic
// ---------------------------------------------------------------------------

/** Model ID substrings that indicate reasoning/thinking support. */
const REASONING_PATTERNS = [
  "thinking",
  "reasoner",
  "reasoning",
  "deepseek.r",
  "gpt-oss-120b", // GPT-OSS 120B supports reasoning
  "gpt-oss-safeguard-120b",
];

function inferReasoningSupport(modelId: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(modelId);
  return REASONING_PATTERNS.some((p) => lower.includes(p));
}

// ---------------------------------------------------------------------------
// Discovery cache
// ---------------------------------------------------------------------------

interface MantleCacheEntry {
  models: ModelDefinitionConfig[];
  fetchedAt: number;
}

const discoveryCache = new Map<string, MantleCacheEntry>();

/** Clear the discovery cache (for testing). */
export function resetMantleDiscoveryCacheForTest(): void {
  discoveryCache.clear();
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

/**
 * Discover available models from the Mantle `/v1/models` endpoint.
 *
 * The response is in standard OpenAI format:
 * ```json
 * { "data": [{ "id": "anthropic.claude-sonnet-4-6", "object": "model", "owned_by": "anthropic" }] }
 * ```
 *
 * Results are cached per region for `DEFAULT_REFRESH_INTERVAL_SECONDS`.
 * Returns an empty array if the request fails (no permission, network error, etc.).
 */
export async function discoverMantleModels(params: {
  region: string;
  bearerToken: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}): Promise<ModelDefinitionConfig[]> {
  const { region, bearerToken, fetchFn = fetch, now = Date.now } = params;

  // Check cache
  const cacheKey = region;
  const cached = discoveryCache.get(cacheKey);
  if (cached && now() - cached.fetchedAt < DEFAULT_REFRESH_INTERVAL_SECONDS * 1000) {
    return cached.models;
  }

  const endpoint = `${mantleEndpoint(region)}/v1/models`;

  try {
    const response = await fetchFn(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      log.debug?.("Mantle model discovery failed", {
        status: response.status,
        statusText: response.statusText,
      });
      return cached?.models ?? [];
    }

    const body = (await response.json()) as OpenAIModelsResponse;
    const rawModels = body.data ?? [];

    const models = rawModels
      .filter((m) => m.id?.trim())
      .map((m) => ({
        id: m.id,
        name: m.id, // Mantle doesn't return display names
        reasoning: inferReasoningSupport(m.id),
        input: ["text" as const],
        cost: DEFAULT_COST,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
      }))
      .toSorted((a, b) => a.id.localeCompare(b.id));

    discoveryCache.set(cacheKey, { models, fetchedAt: now() });
    return models;
  } catch (error) {
    log.debug?.("Mantle model discovery error", {
      error: formatErrorMessage(error),
    });
    return cached?.models ?? [];
  }
}

// ---------------------------------------------------------------------------
// Implicit provider resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an implicit Bedrock Mantle provider if authentication is available.
 *
 * Detection priority:
 * 1. AWS_BEARER_TOKEN_BEDROCK env var → use directly
 * 2. IAM credentials → generate bearer token via `@aws/bedrock-token-generator`
 * - Region from AWS_REGION / AWS_DEFAULT_REGION / default us-east-1
 * - Models discovered from `/v1/models`
 */
export async function resolveImplicitMantleProvider(params: {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  tokenProviderFactory?: MantleBearerTokenProviderFactory;
}): Promise<ModelProviderConfig | null> {
  const env = params.env ?? process.env;
  const region = resolveMantleRegion(env);
  const explicitBearerToken = resolveMantleBearerToken(env);

  if (!isSupportedRegion(region)) {
    log.debug?.("Mantle not available in region", { region });
    return null;
  }

  // Try explicit token first, then generate from IAM credentials
  const bearerToken =
    explicitBearerToken ??
    (await generateBearerTokenFromIam({
      region,
      tokenProviderFactory: params.tokenProviderFactory,
    }));

  if (!bearerToken) {
    return null;
  }

  const models = await discoverMantleModels({
    region,
    bearerToken,
    fetchFn: params.fetchFn,
  });

  if (models.length === 0) {
    return null;
  }

  log.debug?.("Mantle provider resolved", { region, modelCount: models.length });

  // Append Claude models available on Mantle's Anthropic Messages endpoint.
  // Opus 4.7 currently needs the provider-owned bearer-auth path here, but we
  // keep reasoning off until the underlying Anthropic transport learns Opus 4.7
  // adaptive thinking semantics.
  const claudeModels: ModelDefinitionConfig[] = [
    {
      id: "anthropic.claude-opus-4-7",
      name: "Claude Opus 4.7",
      api: "anthropic-messages" as const,
      reasoning: false,
      input: ["text", "image"],
      cost: {
        input: 5,
        output: 25,
        cacheRead: 0.5,
        cacheWrite: 6.25,
      },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    },
  ];
  const allModels = [...models, ...claudeModels];

  return {
    baseUrl: `${mantleEndpoint(region)}/v1`,
    api: "openai-completions",
    auth: "api-key",
    apiKey: explicitBearerToken ? "env:AWS_BEARER_TOKEN_BEDROCK" : MANTLE_IAM_TOKEN_MARKER,
    models: allModels,
  };
}

export function mergeImplicitMantleProvider(params: {
  existing: ModelProviderConfig | undefined;
  implicit: ModelProviderConfig;
}): ModelProviderConfig {
  const { existing, implicit } = params;
  if (!existing) {
    return implicit;
  }
  return {
    ...implicit,
    ...existing,
    models:
      Array.isArray(existing.models) && existing.models.length > 0
        ? existing.models
        : implicit.models,
  };
}
