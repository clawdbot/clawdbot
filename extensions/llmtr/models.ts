/**
 * LLMTR model catalog, static model definitions, and dynamic model discovery.
 */
import {
  getCachedLiveProviderModelRows,
  LiveModelCatalogHttpError,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { ssrfPolicyFromHttpBaseUrlAllowedHostname } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const log = createSubsystemLogger("llmtr-models");

const LLMTR_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "llmtr",
  catalog: manifest.modelCatalog.providers.llmtr,
});

/** Base URL for the LLMTR OpenAI-compatible gateway. */
export const LLMTR_BASE_URL = LLMTR_MANIFEST_PROVIDER.baseUrl;
/** Default LLMTR model id used for onboarding. */
const LLMTR_DEFAULT_MODEL_ID = "anthropic/claude-sonnet-5";
/** Default LLMTR model ref used for onboarding. */
export const LLMTR_DEFAULT_MODEL_REF = `llmtr/${LLMTR_DEFAULT_MODEL_ID}`;

/**
 * Last-resort sizing for a discovered row that publishes no `context_length`.
 * Under-declaring the window truncates history early instead of failing the
 * request upstream.
 */
const LLMTR_DEFAULT_CONTEXT_WINDOW = 32768;
const LLMTR_DEFAULT_MAX_TOKENS = 8192;

/** Bundled fallback LLMTR model catalog, normalized from the plugin manifest. */
export const LLMTR_MODEL_CATALOG: ModelDefinitionConfig[] = LLMTR_MANIFEST_PROVIDER.models;

/** Adds LLMTR provider compat metadata to one model catalog entry. */
export function buildLlmtrModelDefinition(model: ModelDefinitionConfig): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
    compat: {
      ...model.compat,
      // Verified live: LLMTR honours stream_options.include_usage and emits a
      // final usage block on streamed responses. Declaring false here would
      // make every streamed turn report zero token usage.
      supportsUsageInStreaming: true,
    },
  };
}

interface LlmtrModelEntry {
  id?: unknown;
  name?: unknown;
  owned_by?: unknown;
  supported_operations?: unknown;
  context_length?: unknown;
  architecture?: { input_modalities?: unknown } | null;
  pricing?: Record<string, unknown> | null;
  top_provider?: { max_completion_tokens?: unknown } | null;
  supported_parameters?: unknown;
  reasoning?: { mandatory?: unknown; default_enabled?: unknown } | null;
}

const CACHE_TTL = 5 * 60 * 1000;

/**
 * LLMTR routes Responses-only models (OpenAI gpt-5.5+/codex, Grok 4.x, Qwen VL)
 * to `/v1/responses`. This plugin speaks `openai-completions`, so advertising
 * them would surface models that reject every request we can send.
 */
const CHAT_COMPLETIONS_OPERATION = "CHAT_COMPLETIONS";

function supportsChatCompletions(entry: LlmtrModelEntry): boolean {
  return (
    Array.isArray(entry.supported_operations) &&
    entry.supported_operations.includes(CHAT_COMPLETIONS_OPERATION)
  );
}

async function fetchLlmtrModelRows(apiKey?: string): Promise<readonly unknown[]> {
  return await getCachedLiveProviderModelRows({
    providerId: "llmtr",
    endpoint: `${LLMTR_BASE_URL}/models`,
    discoveryApiKey: apiKey,
    timeoutMs: 10_000,
    ttlMs: CACHE_TTL,
    buildRequestHeaders: ({ discoveryApiKey }) => ({
      Accept: "application/json",
      ...(discoveryApiKey ? { Authorization: `Bearer ${discoveryApiKey}` } : {}),
    }),
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(LLMTR_BASE_URL),
    auditContext: "llmtr-model-discovery",
  });
}

const MODEL_INPUT_MODALITIES = ["text", "image", "video", "audio"] as const;
type ModelInputModality = (typeof MODEL_INPUT_MODALITIES)[number];

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/** `pricing` is USD per token; catalog `cost` is USD per million tokens. */
function perMillionTokenCost(value: unknown): number {
  const perToken = typeof value === "string" ? Number(value) : value;
  if (typeof perToken !== "number" || !Number.isFinite(perToken) || perToken <= 0) {
    return 0;
  }
  return Math.round(perToken * 1_000_000 * 1e6) / 1e6;
}

function readInputModalities(entry: LlmtrModelEntry): ModelInputModality[] {
  const declared = entry.architecture?.input_modalities;
  if (!Array.isArray(declared)) {
    return ["text"];
  }
  // `file` is advertised alongside the modalities OpenClaw routes on; drop it.
  const modalities = MODEL_INPUT_MODALITIES.filter((modality) => declared.includes(modality));
  return modalities.length > 0 ? [...modalities] : ["text"];
}

/**
 * Only routes that advertise a reasoning parameter accept OpenClaw's thinking
 * controls; the gateway rejects them elsewhere.
 */
function supportsReasoning(entry: LlmtrModelEntry): boolean {
  const parameters = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];
  return (
    parameters.includes("reasoning") ||
    parameters.includes("reasoning_effort") ||
    entry.reasoning?.mandatory === true ||
    entry.reasoning?.default_enabled === true
  );
}

/**
 * Builds a catalog entry from the discovery row. `/v1/models` publishes
 * `context_length`, `top_provider.max_completion_tokens`, modalities, pricing
 * and reasoning support, so live metadata wins over the bundled snapshot, which
 * only fills gaps the gateway leaves empty.
 */
function buildDiscoveredModel(
  id: string,
  entry: LlmtrModelEntry,
  curated: ModelDefinitionConfig | undefined,
): ModelDefinitionConfig {
  const contextWindow =
    readPositiveInteger(entry.context_length) ??
    curated?.contextWindow ??
    LLMTR_DEFAULT_CONTEXT_WINDOW;
  const declaredMaxTokens =
    readPositiveInteger(entry.top_provider?.max_completion_tokens) ??
    curated?.maxTokens ??
    LLMTR_DEFAULT_MAX_TOKENS;
  return buildLlmtrModelDefinition({
    id,
    name: normalizeOptionalString(entry.name) ?? curated?.name ?? id,
    reasoning: supportsReasoning(entry),
    input: readInputModalities(entry),
    contextWindow,
    maxTokens: Math.min(declaredMaxTokens, contextWindow),
    cost: {
      input: perMillionTokenCost(entry.pricing?.prompt),
      output: perMillionTokenCost(entry.pricing?.completion),
      cacheRead: perMillionTokenCost(entry.pricing?.input_cache_read),
      cacheWrite: perMillionTokenCost(entry.pricing?.input_cache_write),
    },
  });
}

/** Discovers LLMTR models dynamically, falling back to the bundled static catalog. */
export async function discoverLlmtrModels(apiKey?: string): Promise<ModelDefinitionConfig[]> {
  const trimmedKey = normalizeOptionalString(apiKey) ?? "";
  const staticCatalog = () => LLMTR_MODEL_CATALOG.map(buildLlmtrModelDefinition);
  const curatedById = new Map(LLMTR_MODEL_CATALOG.map((model) => [model.id, model]));

  try {
    const rows = await fetchLlmtrModelRows(trimmedKey || undefined);
    if (rows.length === 0) {
      log.warn("No models in response, using static catalog");
      return staticCatalog();
    }

    const seen = new Set<string>();
    const models: ModelDefinitionConfig[] = [];

    for (const entry of rows as LlmtrModelEntry[]) {
      const id = normalizeOptionalString(entry?.id) ?? "";
      if (!id || seen.has(id) || !supportsChatCompletions(entry)) {
        continue;
      }
      seen.add(id);
      models.push(buildDiscoveredModel(id, entry, curatedById.get(id)));
    }

    if (models.length === 0) {
      log.warn("No chat-completions models in response, using static catalog");
      return staticCatalog();
    }
    return models;
  } catch (error) {
    if (error instanceof LiveModelCatalogHttpError && error.status === 401 && trimmedKey) {
      // LLMTR serves /v1/models unauthenticated; retry keyless so a bad key
      // still yields the public catalog instead of the frozen bundled one.
      return await discoverLlmtrModels(undefined);
    }
    log.warn(`Discovery failed: ${String(error)}, using static catalog`);
    return staticCatalog();
  }
}
