import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
  type ListFoundationModelsCommandOutput,
  type ListInferenceProfilesCommandOutput,
} from "@aws-sdk/client-bedrock";

import type { BedrockDiscoveryConfig, ModelDefinitionConfig } from "../config/types.js";

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
type BedrockInferenceProfileSummary = NonNullable<
  ListInferenceProfilesCommandOutput["inferenceProfileSummaries"]
>[number];

type BedrockDiscoveryCacheEntry = {
  expiresAt: number;
  value?: ModelDefinitionConfig[];
  inFlight?: Promise<ModelDefinitionConfig[]>;
};

const discoveryCache = new Map<string, BedrockDiscoveryCacheEntry>();
let hasLoggedBedrockError = false;

function normalizeProviderFilter(filter?: string[]): string[] {
  if (!filter || filter.length === 0) return [];
  const normalized = new Set(
    filter.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0),
  );
  return Array.from(normalized).sort();
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
  return (modalities ?? []).some((entry) => entry.toLowerCase() === "text");
}

function isActive(summary: BedrockModelSummary): boolean {
  const status = summary.modelLifecycle?.status;
  return typeof status === "string" ? status.toUpperCase() === "ACTIVE" : false;
}

function mapInputModalities(summary: BedrockModelSummary): Array<"text" | "image"> {
  const inputs = summary.inputModalities ?? [];
  const mapped = new Set<"text" | "image">();
  for (const modality of inputs) {
    const lower = modality.toLowerCase();
    if (lower === "text") mapped.add("text");
    if (lower === "image") mapped.add("image");
  }
  if (mapped.size === 0) mapped.add("text");
  return Array.from(mapped);
}

function inferReasoningSupport(summary: BedrockModelSummary): boolean {
  const haystack = `${summary.modelId ?? ""} ${summary.modelName ?? ""}`.toLowerCase();
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

function matchesProviderFilter(summary: BedrockModelSummary, filter: string[]): boolean {
  if (filter.length === 0) return true;
  const providerName =
    summary.providerName ??
    (typeof summary.modelId === "string" ? summary.modelId.split(".")[0] : undefined);
  const normalized = providerName?.trim().toLowerCase();
  if (!normalized) return false;
  return filter.includes(normalized);
}

function shouldIncludeSummary(summary: BedrockModelSummary, filter: string[]): boolean {
  if (!summary.modelId?.trim()) return false;
  if (!matchesProviderFilter(summary, filter)) return false;
  if (summary.responseStreamingSupported !== true) return false;
  if (!includesTextModalities(summary.outputModalities)) return false;
  if (!isActive(summary)) return false;
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

function extractBaseModelIdFromArn(arn: string): string | undefined {
  // ARN format: arn:aws:bedrock:region::foundation-model/model-id
  const match = /foundation-model\/(.+)$/.exec(arn);
  return match?.[1];
}

function isActiveInferenceProfile(summary: BedrockInferenceProfileSummary): boolean {
  const status = summary.status;
  return typeof status === "string" ? status.toUpperCase() === "ACTIVE" : false;
}

function matchesInferenceProfileProviderFilter(
  summary: BedrockInferenceProfileSummary,
  filter: string[],
): boolean {
  if (filter.length === 0) return true;
  // Extract provider from inference profile ID (e.g., "global.anthropic.claude-..." -> "anthropic")
  const profileId = summary.inferenceProfileId ?? "";
  const parts = profileId.split(".");
  // Format is: prefix.provider.model (e.g., global.anthropic.claude-3-sonnet...)
  const providerName = parts.length >= 2 ? parts[1] : undefined;
  const normalized = providerName?.trim().toLowerCase();
  if (!normalized) return false;
  return filter.includes(normalized);
}

function inferInferenceProfileCapabilities(
  summary: BedrockInferenceProfileSummary,
  foundationModels: Map<string, BedrockModelSummary>,
): { input: Array<"text" | "image">; reasoning: boolean } {
  // Try to get capabilities from the first underlying foundation model
  const modelArns = summary.models ?? [];
  for (const model of modelArns) {
    const modelArn = model.modelArn;
    if (!modelArn) continue;
    const baseModelId = extractBaseModelIdFromArn(modelArn);
    if (!baseModelId) continue;
    const foundationModel = foundationModels.get(baseModelId);
    if (foundationModel) {
      return {
        input: mapInputModalities(foundationModel),
        reasoning: inferReasoningSupport(foundationModel),
      };
    }
  }
  // Fall back to inferring from the profile ID/name
  const haystack =
    `${summary.inferenceProfileId ?? ""} ${summary.inferenceProfileName ?? ""}`.toLowerCase();
  return {
    input: haystack.includes("embed")
      ? (["text"] as Array<"text" | "image">)
      : (["text", "image"] as Array<"text" | "image">),
    reasoning: haystack.includes("reasoning") || haystack.includes("thinking"),
  };
}

function inferenceProfileToModelDefinition(
  summary: BedrockInferenceProfileSummary,
  foundationModels: Map<string, BedrockModelSummary>,
  defaults: { contextWindow: number; maxTokens: number },
): ModelDefinitionConfig {
  const id = summary.inferenceProfileId?.trim() ?? "";
  const capabilities = inferInferenceProfileCapabilities(summary, foundationModels);
  return {
    id,
    name: summary.inferenceProfileName?.trim() || id,
    reasoning: capabilities.reasoning,
    input: capabilities.input,
    cost: DEFAULT_COST,
    contextWindow: defaults.contextWindow,
    maxTokens: defaults.maxTokens,
  };
}

export function resetBedrockDiscoveryCacheForTest(): void {
  discoveryCache.clear();
  hasLoggedBedrockError = false;
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
    // Fetch foundation models and inference profiles in parallel
    const [foundationResponse, inferenceResponse] = await Promise.all([
      client.send(new ListFoundationModelsCommand({})),
      client.send(new ListInferenceProfilesCommand({})),
    ]);

    // Build a map of foundation models for capability lookups
    const foundationModelMap = new Map<string, BedrockModelSummary>();
    for (const summary of foundationResponse.modelSummaries ?? []) {
      const modelId = summary.modelId?.trim();
      if (modelId) {
        foundationModelMap.set(modelId, summary);
      }
    }

    const discovered: ModelDefinitionConfig[] = [];

    // Add foundation models
    for (const summary of foundationResponse.modelSummaries ?? []) {
      if (!shouldIncludeSummary(summary, providerFilter)) continue;
      discovered.push(
        toModelDefinition(summary, {
          contextWindow: defaultContextWindow,
          maxTokens: defaultMaxTokens,
        }),
      );
    }

    // Add inference profiles (CRIS: global., us., eu., etc.)
    for (const summary of inferenceResponse.inferenceProfileSummaries ?? []) {
      if (!summary.inferenceProfileId?.trim()) continue;
      if (!isActiveInferenceProfile(summary)) continue;
      if (!matchesInferenceProfileProviderFilter(summary, providerFilter)) continue;
      discovered.push(
        inferenceProfileToModelDefinition(summary, foundationModelMap, {
          contextWindow: defaultContextWindow,
          maxTokens: defaultMaxTokens,
        }),
      );
    }

    return discovered.sort((a, b) => a.name.localeCompare(b.name));
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
      console.warn(`[bedrock-discovery] Failed to list models: ${String(error)}`);
    }
    return [];
  }
}
