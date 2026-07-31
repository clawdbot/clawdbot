// Huggingface plugin module implements models behavior.
import { withTrustedEnvProxyGuardedFetchMode } from "openclaw/plugin-sdk/fetch-runtime";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-types";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isHuggingfaceModelDiscoveryTestEnvironment } from "./model-discovery-env.js";

export const HUGGINGFACE_BASE_URL = "https://router.huggingface.co/v1";
export const HUGGINGFACE_POLICY_SUFFIXES = ["cheapest", "fastest", "preferred"] as const;
const HUGGINGFACE_DISCOVERY_TIMEOUT_MS = 30_000;

const HUGGINGFACE_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const HUGGINGFACE_DEFAULT_CONTEXT_WINDOW = 131072;
const HUGGINGFACE_DEFAULT_MAX_TOKENS = 8192;

type HFModelEntry = {
  id: string;
  owned_by?: string;
  name?: string;
  title?: string;
  display_name?: string;
  architecture?: {
    input_modalities?: string[];
  };
  providers?: unknown[];
};

type HFProviderEntry = {
  context_length?: number;
  provider?: string;
  status?: string;
  supports_tools?: boolean;
};

type OpenAIListModelsResponse = {
  data?: HFModelEntry[];
};

type HuggingfaceToolSupportSnapshot = {
  allLiveRoutesExplicitlyUnsupported: boolean;
  byProvider: ReadonlyMap<string, boolean>;
  liveProviders: ReadonlySet<string>;
};

let huggingfaceToolSupportByModel = new Map<string, HuggingfaceToolSupportSnapshot>();

export const HUGGINGFACE_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "deepseek-ai/DeepSeek-R1",
    name: "DeepSeek R1",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 3, output: 7, cacheRead: 3, cacheWrite: 3 },
  },
  {
    id: "deepseek-ai/DeepSeek-V3.1",
    name: "DeepSeek V3.1",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 0.6, output: 1.25, cacheRead: 0.6, cacheWrite: 0.6 },
  },
  {
    id: "openai/gpt-oss-120b",
    name: "GPT-OSS 120B",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
];

export function isHuggingfacePolicyLocked(modelRef: string): boolean {
  const ref = modelRef.trim();
  return HUGGINGFACE_POLICY_SUFFIXES.some((suffix) => ref.endsWith(`:${suffix}`) || ref === suffix);
}

export function buildHuggingfaceModelDefinition(
  model: (typeof HUGGINGFACE_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.compat ? { compat: model.compat } : {}),
  };
}

function normalizeHuggingfaceProviders(providers: HFModelEntry["providers"]): HFProviderEntry[] {
  if (!Array.isArray(providers)) {
    return [];
  }
  return providers.filter(
    (provider): provider is HFProviderEntry =>
      provider !== null && typeof provider === "object" && !Array.isArray(provider),
  );
}

function buildHuggingfaceToolSupportSnapshot(
  entries: readonly HFModelEntry[],
): Map<string, HuggingfaceToolSupportSnapshot> {
  const snapshot = new Map<string, HuggingfaceToolSupportSnapshot>();
  for (const entry of entries) {
    const modelId = normalizeLowercaseStringOrEmpty(entry.id);
    if (!modelId) {
      continue;
    }
    const liveProviders = normalizeHuggingfaceProviders(entry.providers).filter(
      (provider) => provider.status === undefined || provider.status === "live",
    );
    const providerSupport = new Map<string, boolean>();
    const liveProviderIds = new Set<string>();
    for (const provider of liveProviders) {
      const providerId = normalizeLowercaseStringOrEmpty(provider.provider);
      if (!providerId) {
        continue;
      }
      liveProviderIds.add(providerId);
      if (typeof provider.supports_tools !== "boolean") {
        continue;
      }
      providerSupport.set(providerId, provider.supports_tools);
    }
    const allLiveRoutesExplicitlyUnsupported =
      liveProviders.length > 0 &&
      liveProviders.every((provider) => provider.supports_tools === false);
    if (liveProviderIds.size > 0) {
      snapshot.set(modelId, {
        allLiveRoutesExplicitlyUnsupported,
        byProvider: providerSupport,
        liveProviders: liveProviderIds,
      });
    }
  }
  return snapshot;
}

function splitHuggingfaceRouteModelId(modelId: string): {
  baseModelId: string;
  normalizedBaseModelId: string;
  suffix?: string;
} {
  const trimmed = modelId.trim();
  const separator = trimmed.lastIndexOf(":");
  if (separator < 0) {
    return {
      baseModelId: trimmed,
      normalizedBaseModelId: normalizeLowercaseStringOrEmpty(trimmed),
    };
  }
  const baseModelId = trimmed.slice(0, separator);
  return {
    baseModelId,
    normalizedBaseModelId: normalizeLowercaseStringOrEmpty(baseModelId),
    suffix: normalizeLowercaseStringOrEmpty(trimmed.slice(separator + 1)),
  };
}

function isRecognizedHuggingfaceRoute(
  route: ReturnType<typeof splitHuggingfaceRouteModelId>,
): boolean {
  if (!route.suffix) {
    return false;
  }
  if (HUGGINGFACE_POLICY_SUFFIXES.some((suffix) => suffix === route.suffix)) {
    return true;
  }
  return (
    huggingfaceToolSupportByModel
      .get(route.normalizedBaseModelId)
      ?.liveProviders.has(route.suffix) === true
  );
}

export function resolveHuggingfaceRoutedModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  const route = splitHuggingfaceRouteModelId(ctx.modelId);
  if (!route.baseModelId || !isRecognizedHuggingfaceRoute(route)) {
    return undefined;
  }
  const normalizedProvider = normalizeLowercaseStringOrEmpty(ctx.provider);
  const baseModel =
    ctx.modelRegistry.find(ctx.provider, route.baseModelId) ??
    ctx.modelRegistry
      .getAll()
      .find(
        (model) =>
          normalizeLowercaseStringOrEmpty(model.provider) === normalizedProvider &&
          normalizeLowercaseStringOrEmpty(model.id) === route.normalizedBaseModelId,
      );
  if (!baseModel) {
    return undefined;
  }
  return {
    ...baseModel,
    id: ctx.modelId.trim(),
  };
}

export function normalizeHuggingfaceResolvedModel(
  modelId: string,
  model: ProviderRuntimeModel,
): ProviderRuntimeModel | undefined {
  const configuredSupportsTools = model.compat?.supportsTools;
  const route = splitHuggingfaceRouteModelId(modelId);
  const support = huggingfaceToolSupportByModel.get(route.normalizedBaseModelId);
  const isPolicyRoute =
    route.suffix !== undefined &&
    HUGGINGFACE_POLICY_SUFFIXES.some((policySuffix) => policySuffix === route.suffix);
  const supportsTools =
    !route.suffix || isPolicyRoute
      ? support?.allLiveRoutesExplicitlyUnsupported === true
        ? false
        : undefined
      : support?.byProvider.get(route.suffix);
  // Current route metadata owns route capability. A base-model default must not
  // expose tools on a selected route that explicitly reports no tool support.
  if (supportsTools !== false || configuredSupportsTools === false) {
    return undefined;
  }
  return {
    ...model,
    compat: {
      ...model.compat,
      supportsTools: false,
    },
  };
}

function isHuggingfaceQwenHybridThinkingModel(modelId: string): boolean {
  const leaf = normalizeLowercaseStringOrEmpty(modelId).split("/").pop() ?? "";
  if (!leaf.startsWith("qwen3")) {
    return false;
  }
  // Qwen publishes separate thinking-only, non-thinking Instruct, and
  // specialized Coder / retrieval variants under the same family prefix.
  // Only hybrid/base models accept the chat-template thinking switch.
  return !/(?:coder|embedding|reranker|instruct|thinking)/u.test(leaf);
}

function isReasoningModelHeuristic(modelId: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(modelId);
  return (
    isHuggingfaceQwenHybridThinkingModel(modelId) ||
    lower.includes("r1") ||
    lower.includes("reason") ||
    lower.includes("thinking") ||
    lower.includes("reasoner") ||
    lower.includes("grok") ||
    lower.includes("qwq")
  );
}

function inferredMetaFromModelId(id: string): {
  name: string;
  reasoning: boolean;
  compat?: ModelDefinitionConfig["compat"];
} {
  const base = id.split("/").pop() ?? id;
  const reasoning = isReasoningModelHeuristic(id);
  const name = base.replace(/-/g, " ").replace(/\b(\w)/g, (c) => c.toUpperCase());
  return {
    name,
    reasoning,
    ...(isHuggingfaceQwenHybridThinkingModel(id)
      ? { compat: { thinkingFormat: "qwen-chat-template" } }
      : {}),
  };
}

function displayNameFromApiEntry(entry: HFModelEntry, inferredName: string): string {
  const fromApi =
    (typeof entry.name === "string" && entry.name.trim()) ||
    (typeof entry.title === "string" && entry.title.trim()) ||
    (typeof entry.display_name === "string" && entry.display_name.trim());
  if (fromApi) {
    return fromApi;
  }
  if (typeof entry.owned_by === "string" && entry.owned_by.trim()) {
    const base = entry.id.split("/").pop() ?? entry.id;
    return `${entry.owned_by.trim()}/${base}`;
  }
  return inferredName;
}

export async function discoverHuggingfaceModels(
  apiKey: string,
  timeoutMs = HUGGINGFACE_DISCOVERY_TIMEOUT_MS,
): Promise<ModelDefinitionConfig[]> {
  if (isHuggingfaceModelDiscoveryTestEnvironment()) {
    return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
  }

  const trimmedKey = apiKey?.trim();
  if (!trimmedKey) {
    return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
  }

  try {
    const requestTimeoutMs = resolveTimerTimeoutMs(timeoutMs, HUGGINGFACE_DISCOVERY_TIMEOUT_MS);
    const { response, release } = await fetchWithSsrFGuard(
      withTrustedEnvProxyGuardedFetchMode({
        url: `${HUGGINGFACE_BASE_URL}/models`,
        init: {
          signal: AbortSignal.timeout(requestTimeoutMs),
          headers: {
            Authorization: `Bearer ${trimmedKey}`,
            "Content-Type": "application/json",
          },
        },
        timeoutMs: requestTimeoutMs,
        policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(HUGGINGFACE_BASE_URL),
        auditContext: "huggingface-model-discovery",
      }),
    );
    try {
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
      }

      const body = await readProviderJsonResponse<OpenAIListModelsResponse>(
        response,
        "huggingface.model-discovery",
      );
      const data = body?.data;
      if (!Array.isArray(data)) {
        return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
      }
      huggingfaceToolSupportByModel = buildHuggingfaceToolSupportSnapshot(data);
      if (data.length === 0) {
        return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
      }

      const catalogById = new Map(
        HUGGINGFACE_MODEL_CATALOG.map((model) => [model.id, model] as const),
      );
      const seen = new Set<string>();
      const models: ModelDefinitionConfig[] = [];

      for (const entry of data) {
        const id = typeof entry?.id === "string" ? entry.id.trim() : "";
        if (!id || seen.has(id)) {
          continue;
        }
        seen.add(id);

        const catalogEntry = catalogById.get(id);
        if (catalogEntry) {
          models.push(buildHuggingfaceModelDefinition(catalogEntry));
          continue;
        }

        const inferred = inferredMetaFromModelId(id);
        const name = displayNameFromApiEntry(entry, inferred.name);
        const modalities = entry.architecture?.input_modalities;
        const input: Array<"text" | "image"> =
          Array.isArray(modalities) && modalities.includes("image") ? ["text", "image"] : ["text"];
        const providers = normalizeHuggingfaceProviders(entry.providers);
        const providerWithContext = providers.find(
          (provider) => typeof provider?.context_length === "number" && provider.context_length > 0,
        );
        models.push({
          id,
          name,
          reasoning: inferred.reasoning,
          input,
          cost: HUGGINGFACE_DEFAULT_COST,
          ...(inferred.compat ? { compat: inferred.compat } : {}),
          contextWindow: providerWithContext?.context_length ?? HUGGINGFACE_DEFAULT_CONTEXT_WINDOW,
          maxTokens: HUGGINGFACE_DEFAULT_MAX_TOKENS,
        });
      }

      return models.length > 0
        ? models
        : HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
    } finally {
      await release();
    }
  } catch {
    return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
  }
}
