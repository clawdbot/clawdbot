import {
  BedrockClient,
  ListFoundationModelsCommand,
  type ListFoundationModelsCommandOutput,
  ListInferenceProfilesCommand,
  type ListInferenceProfilesCommandOutput,
} from "@aws-sdk/client-bedrock";
import { createSubsystemLogger } from "openclaw/plugin-sdk/core";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveAwsSdkEnvVarName } from "openclaw/plugin-sdk/provider-auth-runtime";
import type {
  BedrockDiscoveryConfig,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/text-runtime";

const log = createSubsystemLogger("bedrock-discovery");

const DEFAULT_REFRESH_INTERVAL_SECONDS = 3600;
const DEFAULT_CONTEXT_WINDOW = 32_000;
const DEFAULT_MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// Known model context windows (Bedrock API does not expose token limits)
// ---------------------------------------------------------------------------

/**
 * Bedrock's ListFoundationModels and GetFoundationModel APIs return no token
 * limit information — only model ID, name, modalities, and lifecycle status.
 * There is currently no Bedrock API to discover context windows or max output
 * tokens programmatically.
 *
 * This map provides correct context window values for known models so that
 * session management, compaction thresholds, and context overflow detection
 * work correctly. If AWS adds token metadata to the API in the future, this
 * table should become a fallback rather than the primary source.
 *
 * Inference profile prefixes (us., eu., ap., global.) are stripped before lookup.
 *
 * Sources: https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html
 *          https://platform.claude.com/docs/en/about-claude/models
 */
const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic Claude
  "anthropic.claude-3-7-sonnet-20250219-v1:0": 200_000,
  "anthropic.claude-opus-4-7": 1_000_000,
  "anthropic.claude-opus-4-6-v1": 1_000_000,
  "anthropic.claude-opus-4-6-v1:0": 1_000_000,
  "anthropic.claude-sonnet-4-6": 1_000_000,
  "anthropic.claude-sonnet-4-6-v1:0": 1_000_000,
  "anthropic.claude-sonnet-4-5-20250929-v1:0": 200_000,
  "anthropic.claude-sonnet-4-20250514-v1:0": 200_000,
  "anthropic.claude-opus-4-5-20251101-v1:0": 200_000,
  "anthropic.claude-opus-4-1-20250805-v1:0": 200_000,
  "anthropic.claude-haiku-4-5-20251001-v1:0": 200_000,
  "anthropic.claude-3-5-haiku-20241022-v1:0": 200_000,
  "anthropic.claude-3-haiku-20240307-v1:0": 200_000,
  // Amazon Nova
  "amazon.nova-premier-v1:0": 1_000_000,
  "amazon.nova-pro-v1:0": 300_000,
  "amazon.nova-lite-v1:0": 300_000,
  "amazon.nova-micro-v1:0": 128_000,
  "amazon.nova-2-lite-v1:0": 300_000,
  // MiniMax
  "minimax.minimax-m2.5": 1_000_000,
  "minimax.minimax-m2.1": 1_000_000,
  "minimax.minimax-m2": 1_000_000,
  // Meta Llama 4
  "meta.llama4-maverick-17b-instruct-v1:0": 1_000_000,
  "meta.llama4-scout-17b-instruct-v1:0": 512_000,
  // Meta Llama 3
  "meta.llama3-3-70b-instruct-v1:0": 128_000,
  "meta.llama3-2-90b-instruct-v1:0": 128_000,
  "meta.llama3-2-11b-instruct-v1:0": 128_000,
  "meta.llama3-2-3b-instruct-v1:0": 128_000,
  "meta.llama3-2-1b-instruct-v1:0": 128_000,
  "meta.llama3-1-405b-instruct-v1:0": 128_000,
  "meta.llama3-1-70b-instruct-v1:0": 128_000,
  "meta.llama3-1-8b-instruct-v1:0": 128_000,
  // NVIDIA Nemotron
  "nvidia.nemotron-super-3-120b": 256_000,
  "nvidia.nemotron-nano-3-30b": 128_000,
  "nvidia.nemotron-nano-12b-v2": 128_000,
  "nvidia.nemotron-nano-9b-v2": 128_000,
  // Mistral
  "mistral.mistral-large-3-675b-instruct": 128_000,
  "mistral.mistral-large-2407-v1:0": 128_000,
  "mistral.mistral-small-2402-v1:0": 32_000,
  // DeepSeek
  "deepseek.r1-v1:0": 128_000,
  "deepseek.v3.2": 128_000,
  // Cohere
  "cohere.command-r-plus-v1:0": 128_000,
  "cohere.command-r-v1:0": 128_000,
  // AI21
  "ai21.jamba-1-5-large-v1:0": 256_000,
  "ai21.jamba-1-5-mini-v1:0": 256_000,
  // Google Gemma
  "google.gemma-3-27b-it": 128_000,
  "google.gemma-3-12b-it": 128_000,
  "google.gemma-3-4b-it": 128_000,
  // GLM
  "zai.glm-5": 128_000,
  "zai.glm-4.7": 128_000,
  "zai.glm-4.7-flash": 128_000,
  // Qwen
  "qwen.qwen3-coder-next": 256_000,
  "qwen.qwen3-coder-30b-a3b-v1:0": 256_000,
  "qwen.qwen3-32b-v1:0": 128_000,
  "qwen.qwen3-vl-235b-a22b": 128_000,
};

/**
 * Resolve the real context window for a Bedrock model ID.
 * Strips inference profile prefixes (us., eu., ap., global.) before lookup.
 */
function resolveKnownContextWindow(modelId: string): number | undefined {
  const stripped = modelId.replace(/^(?:us|eu|ap|apac|au|jp|global)\./, "");
  const candidates = [modelId, stripped];
  for (const candidate of candidates) {
    if (KNOWN_CONTEXT_WINDOWS[candidate] !== undefined) {
      return KNOWN_CONTEXT_WINDOWS[candidate];
    }
    const withoutVersionSuffix = candidate.replace(/:0$/, "");
    if (
      withoutVersionSuffix !== candidate &&
      KNOWN_CONTEXT_WINDOWS[withoutVersionSuffix] !== undefined
    ) {
      return KNOWN_CONTEXT_WINDOWS[withoutVersionSuffix];
    }
  }
  return undefined;
}

const DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

type BedrockModelSummary = NonNullable<ListFoundationModelsCommandOutput["modelSummaries"]>[number];

type InferenceProfileSummary = NonNullable<
  ListInferenceProfilesCommandOutput["inferenceProfileSummaries"]
>[number];

type BedrockDiscoveryCacheEntry = {
  expiresAt: number;
  value?: ModelDefinitionConfig[];
  inFlight?: Promise<ModelDefinitionConfig[]>;
};

const discoveryCache = new Map<string, BedrockDiscoveryCacheEntry>();
let hasLoggedBedrockError = false;

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

function normalizeProviderFilter(filter?: string[]): string[] {
  if (!filter || filter.length === 0) {
    return [];
  }
  const normalized = new Set(
    filter
      .map((entry) => normalizeOptionalLowercaseString(entry))
      .filter((entry): entry is string => Boolean(entry)),
  );
  return Array.from(normalized).toSorted();
}

function buildCacheKey(params: {
  region: string;
  providerFilter: string[];
  refreshIntervalSeconds: number;
  defaultContextWindow: number;
  defaultMaxTokens: number;
}): string {
  return JSON.stringify(params);
}

function includesTextModalities(modalities?: Array<string>): boolean {
  return (modalities ?? []).some((entry) => normalizeOptionalLowercaseString(entry) === "text");
}

function isActive(summary: BedrockModelSummary): boolean {
  const status = summary.modelLifecycle?.status;
  return typeof status === "string" ? status.toUpperCase() === "ACTIVE" : false;
}

function mapInputModalities(summary: BedrockModelSummary): Array<"text" | "image"> {
  const inputs = summary.inputModalities ?? [];
  const mapped = new Set<"text" | "image">();
  for (const modality of inputs) {
    const lower = normalizeOptionalLowercaseString(modality);
    if (lower === "text") {
      mapped.add("text");
    }
    if (lower === "image") {
      mapped.add("image");
    }
  }
  if (mapped.size === 0) {
    mapped.add("text");
  }
  return Array.from(mapped);
}

function inferReasoningSupport(summary: BedrockModelSummary): boolean {
  const haystack = normalizeLowercaseStringOrEmpty(
    `${summary.modelId ?? ""} ${summary.modelName ?? ""}`,
  );
  return haystack.includes("reasoning") || haystack.includes("thinking");
}

function resolveDefaultContextWindow(config?: BedrockDiscoveryConfig): number {
  const value = Math.floor(config?.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW);
  return value > 0 ? value : DEFAULT_CONTEXT_WINDOW;
}

function resolveDefaultMaxTokens(config?: BedrockDiscoveryConfig): number {
  const value = Math.floor(config?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS);
  return value > 0 ? value : DEFAULT_MAX_TOKENS;
}

// ---------------------------------------------------------------------------
// Foundation model helpers
// ---------------------------------------------------------------------------

function matchesProviderFilter(summary: BedrockModelSummary, filter: string[]): boolean {
  if (filter.length === 0) {
    return true;
  }
  const providerName =
    summary.providerName ??
    (typeof summary.modelId === "string" ? summary.modelId.split(".")[0] : undefined);
  const normalized = normalizeOptionalLowercaseString(providerName);
  if (!normalized) {
    return false;
  }
  return filter.includes(normalized);
}

function shouldIncludeSummary(summary: BedrockModelSummary, filter: string[]): boolean {
  if (!summary.modelId?.trim()) {
    return false;
  }
  if (!matchesProviderFilter(summary, filter)) {
    return false;
  }
  if (summary.responseStreamingSupported !== true) {
    return false;
  }
  if (!includesTextModalities(summary.outputModalities)) {
    return false;
  }
  if (!isActive(summary)) {
    return false;
  }
  return true;
}

function toModelDefinition(
  summary: BedrockModelSummary,
  defaults: { contextWindow: number; maxTokens: number },
): ModelDefinitionConfig {
  const id = summary.modelId?.trim() ?? "";
  return {
    id,
    name: summary.modelName?.trim() || id,
    reasoning: inferReasoningSupport(summary),
    input: mapInputModalities(summary),
    cost: DEFAULT_COST,
    contextWindow: resolveKnownContextWindow(id) ?? defaults.contextWindow,
    maxTokens: defaults.maxTokens,
  };
}

// ---------------------------------------------------------------------------
// Inference profile helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the base foundation model ID from an inference profile.
 *
 * System-defined profiles use a region prefix:
 *   "us.anthropic.claude-sonnet-4-6" → "anthropic.claude-sonnet-4-6"
 *
 * Application profiles carry the model ARN in their models[] array:
 *   models[0].modelArn = "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6"
 *   → "anthropic.claude-sonnet-4-6"
 */
function resolveBaseModelId(profile: InferenceProfileSummary): string | undefined {
  const firstArn = profile.models?.[0]?.modelArn;
  if (firstArn) {
    const arnMatch = /foundation-model\/(.+)$/.exec(firstArn);
    if (arnMatch) {
      return arnMatch[1];
    }
  }
  if (profile.type === "SYSTEM_DEFINED") {
    const id = profile.inferenceProfileId ?? "";
    const prefixMatch = /^(?:us|eu|ap|apac|au|jp|global)\.(.+)$/i.exec(id);
    if (prefixMatch) {
      return prefixMatch[1];
    }
  }
  return undefined;
}

/**
 * Fetch raw inference profile summaries from the Bedrock control plane.
 * Handles pagination. Best-effort: silently returns empty array if IAM lacks
 * bedrock:ListInferenceProfiles permission.
 */
async function fetchInferenceProfileSummaries(
  client: BedrockClient,
): Promise<InferenceProfileSummary[]> {
  try {
    const profiles: InferenceProfileSummary[] = [];
    let nextToken: string | undefined;
    do {
      const response: ListInferenceProfilesCommandOutput = await client.send(
        new ListInferenceProfilesCommand({ nextToken }),
      );
      for (const summary of response.inferenceProfileSummaries ?? []) {
        profiles.push(summary);
      }
      nextToken = response.nextToken;
    } while (nextToken);
    return profiles;
  } catch (error) {
    log.debug?.("Skipping inference profile discovery", {
      error: formatErrorMessage(error),
    });
    return [];
  }
}

/**
 * Convert raw inference profile summaries into model definitions.
 *
 * Each profile inherits capabilities (modalities, reasoning, context window,
 * cost) from its underlying foundation model. This ensures that
 * "us.anthropic.claude-sonnet-4-6" has the same capabilities as
 * "anthropic.claude-sonnet-4-6" — including image input, reasoning support,
 * and token limits.
 *
 * When the foundation model isn't found in the map (e.g. the model is only
 * available via inference profiles in this region), safe defaults are used.
 */
function resolveInferenceProfiles(
  profiles: InferenceProfileSummary[],
  defaults: { contextWindow: number; maxTokens: number },
  providerFilter: string[],
  foundationModels: Map<string, ModelDefinitionConfig>,
): ModelDefinitionConfig[] {
  const discovered: ModelDefinitionConfig[] = [];
  for (const profile of profiles) {
    if (!profile.inferenceProfileId?.trim()) {
      continue;
    }
    if (profile.status !== "ACTIVE") {
      continue;
    }

    // Apply provider filter: check if any of the underlying models match.
    if (providerFilter.length > 0) {
      const models = profile.models ?? [];
      const matchesFilter = models.some((m) => {
        const provider = m.modelArn?.split("/")?.[1]?.split(".")?.[0];
        return provider
          ? providerFilter.includes(normalizeOptionalLowercaseString(provider) ?? "")
          : false;
      });
      if (!matchesFilter) {
        continue;
      }
    }

    // Look up the underlying foundation model to inherit its capabilities.
    const baseModelId = resolveBaseModelId(profile);
    const baseModel = baseModelId
      ? foundationModels.get(normalizeLowercaseStringOrEmpty(baseModelId))
      : undefined;

    discovered.push({
      id: profile.inferenceProfileId,
      name: profile.inferenceProfileName?.trim() || profile.inferenceProfileId,
      reasoning: baseModel?.reasoning ?? false,
      input: baseModel?.input ?? ["text"],
      cost: baseModel?.cost ?? DEFAULT_COST,
      contextWindow:
        baseModel?.contextWindow ??
        resolveKnownContextWindow(baseModelId ?? profile.inferenceProfileId ?? "") ??
        defaults.contextWindow,
      maxTokens: baseModel?.maxTokens ?? defaults.maxTokens,
    });
  }
  return discovered;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function resetBedrockDiscoveryCacheForTest(): void {
  discoveryCache.clear();
  hasLoggedBedrockError = false;
}

export function resolveBedrockConfigApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  // When no AWS auth env marker is present, Bedrock should fall back to the
  // AWS SDK default credential chain instead of persisting a fake apiKey marker.
  return resolveAwsSdkEnvVarName(env);
}

export async function discoverBedrockModels(params: {
  region: string;
  config?: BedrockDiscoveryConfig;
  now?: () => number;
  clientFactory?: (region: string) => BedrockClient;
}): Promise<ModelDefinitionConfig[]> {
  const refreshIntervalSeconds = Math.max(
    0,
    Math.floor(params.config?.refreshInterval ?? DEFAULT_REFRESH_INTERVAL_SECONDS),
  );
  const providerFilter = normalizeProviderFilter(params.config?.providerFilter);
  const defaultContextWindow = resolveDefaultContextWindow(params.config);
  const defaultMaxTokens = resolveDefaultMaxTokens(params.config);
  const cacheKey = buildCacheKey({
    region: params.region,
    providerFilter,
    refreshIntervalSeconds,
    defaultContextWindow,
    defaultMaxTokens,
  });
  const now = params.now?.() ?? Date.now();

  if (refreshIntervalSeconds > 0) {
    const cached = discoveryCache.get(cacheKey);
    if (cached?.value && cached.expiresAt > now) {
      return cached.value;
    }
    if (cached?.inFlight) {
      return cached.inFlight;
    }
  }

  const clientFactory = params.clientFactory ?? ((region: string) => new BedrockClient({ region }));
  const client = clientFactory(params.region);

  const discoveryPromise = (async () => {
    // Discover foundation models and inference profiles in parallel.
    // Both API calls are independent, but we need the foundation model data
    // to resolve inference profile capabilities — so we fetch in parallel,
    // then build the lookup map before processing profiles.
    const [foundationResponse, profileSummaries] = await Promise.all([
      client.send(new ListFoundationModelsCommand({})),
      fetchInferenceProfileSummaries(client),
    ]);

    const discovered: ModelDefinitionConfig[] = [];
    const seenIds = new Set<string>();
    const foundationModels = new Map<string, ModelDefinitionConfig>();

    // Foundation models first — build both the results list and the lookup map.
    for (const summary of foundationResponse.modelSummaries ?? []) {
      if (!shouldIncludeSummary(summary, providerFilter)) {
        continue;
      }
      const def = toModelDefinition(summary, {
        contextWindow: defaultContextWindow,
        maxTokens: defaultMaxTokens,
      });
      discovered.push(def);
      const normalizedId = normalizeLowercaseStringOrEmpty(def.id);
      seenIds.add(normalizedId);
      foundationModels.set(normalizedId, def);
    }

    // Merge inference profiles — inherit capabilities from foundation models.
    const inferenceProfiles = resolveInferenceProfiles(
      profileSummaries,
      { contextWindow: defaultContextWindow, maxTokens: defaultMaxTokens },
      providerFilter,
      foundationModels,
    );
    for (const profile of inferenceProfiles) {
      const normalizedId = normalizeLowercaseStringOrEmpty(profile.id);
      if (!seenIds.has(normalizedId)) {
        discovered.push(profile);
        seenIds.add(normalizedId);
      }
    }

    // Sort: global cross-region profiles first (recommended for most users —
    // better capacity, automatic failover, no data sovereignty constraints),
    // then remaining profiles/models alphabetically.
    return discovered.toSorted((a, b) => {
      const aGlobal = a.id.startsWith("global.") ? 0 : 1;
      const bGlobal = b.id.startsWith("global.") ? 0 : 1;
      if (aGlobal !== bGlobal) {
        return aGlobal - bGlobal;
      }
      return a.name.localeCompare(b.name);
    });
  })();

  if (refreshIntervalSeconds > 0) {
    discoveryCache.set(cacheKey, {
      expiresAt: now + refreshIntervalSeconds * 1000,
      inFlight: discoveryPromise,
    });
  }

  try {
    const value = await discoveryPromise;
    if (refreshIntervalSeconds > 0) {
      discoveryCache.set(cacheKey, {
        expiresAt: now + refreshIntervalSeconds * 1000,
        value,
      });
    }
    return value;
  } catch (error) {
    if (refreshIntervalSeconds > 0) {
      discoveryCache.delete(cacheKey);
    }
    if (!hasLoggedBedrockError) {
      hasLoggedBedrockError = true;
      log.warn("Failed to discover Bedrock models", {
        error: formatErrorMessage(error),
      });
    }
    return [];
  }
}

export async function resolveImplicitBedrockProvider(params: {
  config?: { models?: { bedrockDiscovery?: BedrockDiscoveryConfig } };
  pluginConfig?: { discovery?: BedrockDiscoveryConfig };
  env?: NodeJS.ProcessEnv;
  clientFactory?: (region: string) => BedrockClient;
}): Promise<ModelProviderConfig | null> {
  const env = params.env ?? process.env;
  const discoveryConfig = {
    ...params.config?.models?.bedrockDiscovery,
    ...params.pluginConfig?.discovery,
  };
  const enabled = discoveryConfig?.enabled;
  const hasAwsCreds = resolveAwsSdkEnvVarName(env) !== undefined;
  if (enabled === false) {
    return null;
  }
  if (enabled !== true && !hasAwsCreds) {
    return null;
  }

  const region = discoveryConfig?.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1";
  const models = await discoverBedrockModels({
    region,
    config: discoveryConfig,
    clientFactory: params.clientFactory,
  });
  if (models.length === 0) {
    return null;
  }

  return {
    baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
    api: "bedrock-converse-stream",
    auth: "aws-sdk",
    models,
  };
}

export function mergeImplicitBedrockProvider(params: {
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
