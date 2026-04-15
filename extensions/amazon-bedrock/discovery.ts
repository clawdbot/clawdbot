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
const DEFAULT_CONTEXT_WINDOW = 32000;
const DEFAULT_MAX_TOKENS = 4096;
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
    contextWindow: defaults.contextWindow,
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
    const prefixMatch = /^(?:us|eu|ap|jp|global)\.(.+)$/i.exec(id);
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
      contextWindow: baseModel?.contextWindow ?? defaults.contextWindow,
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
