/**
 * Baseten model catalog, compat metadata, and live row projection.
 */
import {
  buildManifestModelProviderConfig,
  readManifestProviderDefaultModelRef,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelCompatConfig,
  ModelDefinitionConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { asNonArrayRecord, filterStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const BASETEN_MANIFEST_CATALOG = manifest.modelCatalog.providers.baseten;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

const CHAT_TEMPLATE_THINKING_MODEL_IDS = new Set([
  "zai-org/glm-4.7",
  "zai-org/glm-5.2",
  "zai-org/glm-5.2-fast",
  "moonshotai/kimi-k2.6",
  "moonshotai/kimi-k2.7-code",
  "nvidia/nvidia-nemotron-3-ultra-550b-a55b",
]);

const FULL_REASONING_EFFORT_MODEL_IDS = new Set([
  "deepseek-ai/DeepSeek-V4-Pro",
  "openai/gpt-oss-120b",
]);

const INKLING_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
const FULL_REASONING_EFFORTS = [...INKLING_REASONING_EFFORTS, "max"];

const BASE_COMPAT: ModelCompatConfig = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsUsageInStreaming: true,
  supportsStrictMode: true,
  supportsTools: true,
  maxTokensField: "max_tokens",
};

/** Base URL for Baseten's OpenAI-compatible Model APIs. */
export const BASETEN_BASE_URL = BASETEN_MANIFEST_CATALOG.baseUrl;
/** Default Baseten model id used for onboarding. */
export const BASETEN_DEFAULT_MODEL_ID = BASETEN_MANIFEST_CATALOG.defaultModel;
/** Default Baseten model ref used for onboarding. */
export const BASETEN_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(manifest, "baseten")!;
/** Bundled fallback rows for all Baseten Model APIs available at release time. */
export const BASETEN_MODEL_CATALOG = BASETEN_MANIFEST_CATALOG.models;

/** Whether Baseten requires chat-template thinking control for this model. */
export function usesBasetenChatTemplateThinking(modelId: string): boolean {
  return CHAT_TEMPLATE_THINKING_MODEL_IDS.has(modelId.trim().toLowerCase());
}

function buildBasetenReasoningCompat(modelId: string): ModelCompatConfig {
  if (FULL_REASONING_EFFORT_MODEL_IDS.has(modelId)) {
    return {
      supportsReasoningEffort: true,
      supportedReasoningEfforts: FULL_REASONING_EFFORTS,
      reasoningEffortMap: {
        off: "none",
        none: "none",
        adaptive: "max",
      },
    };
  }
  if (modelId === BASETEN_DEFAULT_MODEL_ID) {
    return {
      supportsReasoningEffort: true,
      supportedReasoningEfforts: INKLING_REASONING_EFFORTS,
      reasoningEffortMap: {
        off: "none",
        none: "none",
        adaptive: "xhigh",
        max: "xhigh",
      },
    };
  }
  if (modelId === "zai-org/GLM-5.2" || modelId === "zai-org/GLM-5.2-Fast") {
    return {
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["none", "high", "max"],
      reasoningEffortMap: {
        off: "none",
        none: "none",
        minimal: "high",
        low: "high",
        medium: "high",
        xhigh: "high",
        adaptive: "max",
      },
    };
  }
  return {};
}

/** Complete OpenAI-compatible transport policy for one Baseten model. */
export function buildBasetenModelCompat(modelId: string): ModelCompatConfig {
  return {
    ...BASE_COMPAT,
    ...buildBasetenReasoningCompat(modelId),
  };
}

/** Builds the network-free fallback catalog. */
export function buildStaticBasetenModels(): ModelDefinitionConfig[] {
  return buildManifestModelProviderConfig({
    providerId: "baseten",
    catalog: BASETEN_MANIFEST_CATALOG,
  }).models.map((model) => Object.assign(model, { compat: buildBasetenModelCompat(model.id) }));
}

type BasetenLiveModelRow = {
  id?: unknown;
  object?: unknown;
  name?: unknown;
  context_length?: unknown;
  max_completion_tokens?: unknown;
  pricing?: unknown;
  supported_features?: unknown;
};

function readPositiveInteger(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function readPerTokenPrice(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) {
    return undefined;
  }
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0
    ? Number((number * 1_000_000).toFixed(9))
    : undefined;
}

function applyLiveReasoningEffortCompat(
  fallbackCompat: ModelCompatConfig,
  supportsReasoningEffort: boolean,
): ModelCompatConfig {
  if (supportsReasoningEffort) {
    return { ...fallbackCompat, supportsReasoningEffort: true };
  }
  const compat = { ...fallbackCompat };
  delete compat.supportsReasoningEffort;
  delete compat.supportedReasoningEfforts;
  delete compat.reasoningEffortMap;
  return compat;
}

function projectLiveModel(
  row: BasetenLiveModelRow,
  fallback: ModelDefinitionConfig | undefined,
): ModelDefinitionConfig | undefined {
  if (row.object !== undefined && row.object !== "model") {
    return undefined;
  }
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id) {
    return undefined;
  }

  const hasLiveFeatures = Array.isArray(row.supported_features);
  const features = new Set(filterStringEntries(row.supported_features));
  const pricing = asNonArrayRecord(row.pricing);
  const inputPrice = readPerTokenPrice(pricing.prompt);
  const outputPrice = readPerTokenPrice(pricing.completion);
  const cacheReadPrice = readPerTokenPrice(pricing.input_cache_read);
  const supportsReasoningEffort = features.has("reasoning_effort");
  const fallbackCompat = fallback?.compat ?? buildBasetenModelCompat(id);
  const compat = hasLiveFeatures
    ? applyLiveReasoningEffortCompat(fallbackCompat, supportsReasoningEffort)
    : fallbackCompat;

  return {
    id,
    name:
      typeof row.name === "string" && row.name.trim() ? row.name.trim() : (fallback?.name ?? id),
    reasoning: hasLiveFeatures
      ? features.has("reasoning") || supportsReasoningEffort
      : (fallback?.reasoning ?? false),
    input: hasLiveFeatures
      ? features.has("vision")
        ? ["text", "image"]
        : ["text"]
      : (fallback?.input ?? ["text"]),
    cost: {
      input: inputPrice ?? fallback?.cost.input ?? 0,
      output: outputPrice ?? fallback?.cost.output ?? 0,
      cacheRead: cacheReadPrice ?? fallback?.cost.cacheRead ?? 0,
      cacheWrite: fallback?.cost.cacheWrite ?? 0,
    },
    contextWindow:
      readPositiveInteger(row.context_length) ?? fallback?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens:
      readPositiveInteger(row.max_completion_tokens) ?? fallback?.maxTokens ?? DEFAULT_MAX_TOKENS,
    compat,
  };
}

/** Projects Baseten's authenticated `/models` response into OpenClaw model rows. */
export function projectBasetenLiveModels(rows: readonly unknown[]): ModelDefinitionConfig[] {
  const fallbacks = new Map(buildStaticBasetenModels().map((model) => [model.id, model]));
  const seen = new Set<string>();
  const models: ModelDefinitionConfig[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const model = projectLiveModel(
      row as BasetenLiveModelRow,
      fallbacks.get(String((row as BasetenLiveModelRow).id)),
    );
    if (!model || seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

/** Resolves a forward-compatible Baseten model id not yet in the bundled catalog. */
export function resolveBasetenDynamicModel(modelId: string) {
  const id = modelId.trim();
  if (!id || BASETEN_MODEL_CATALOG.some((model) => model.id === id)) {
    return undefined;
  }
  return {
    id,
    name: id,
    provider: "baseten",
    api: "openai-completions" as const,
    baseUrl: BASETEN_BASE_URL,
    reasoning: false,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: buildBasetenModelCompat(id),
  };
}
