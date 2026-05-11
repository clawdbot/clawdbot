import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-types";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isHuggingfaceModelDiscoveryTestEnvironment } from "./model-discovery-env.js";

export const HUGGINGFACE_BASE_URL = "https://router.huggingface.co/v1";
export const HUGGINGFACE_POLICY_SUFFIXES = ["cheapest", "fastest"] as const;
export const HUGGINGFACE_DISCOVERY_TIMEOUT_MS = 30_000;

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
  providers?: Array<{
    context_length?: number;
  }>;
};

type OpenAIListModelsResponse = {
  data?: HFModelEntry[];
};

export const HUGGINGFACE_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "deepseek-ai/DeepSeek-R1",
    name: "DeepSeek R1",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 3.0, output: 7.0, cacheRead: 3.0, cacheWrite: 3.0 },
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
    id: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    name: "Llama 3.3 70B Instruct Turbo",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 0.88, output: 0.88, cacheRead: 0.88, cacheWrite: 0.88 },
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
  };
}

function isReasoningModelHeuristic(modelId: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(modelId);
  return (
    lower.includes("r1") ||
    lower.includes("reason") ||
    lower.includes("thinking") ||
    lower.includes("reasoner") ||
    lower.includes("grok") ||
    lower.includes("qwq")
  );
}

function inferredMetaFromModelId(id: string): { name: string; reasoning: boolean } {
  const base = id.split("/").pop() ?? id;
  const reasoning = isReasoningModelHeuristic(id);
  const name = base.replace(/-/g, " ").replace(/\b(\w)/g, (c) => c.toUpperCase());
  return { name, reasoning };
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
    const { response, release } = await fetchWithSsrFGuard({
      url: `${HUGGINGFACE_BASE_URL}/models`,
      init: {
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: `Bearer ${trimmedKey}`,
          "Content-Type": "application/json",
        },
      },
      policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(HUGGINGFACE_BASE_URL),
      auditContext: "huggingface-model-discovery",
    });
    try {
      if (!response.ok) {
        return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
      }

      const body = (await response.json()) as OpenAIListModelsResponse;
      const data = body?.data;
      if (!Array.isArray(data) || data.length === 0) {
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
        const providers = Array.isArray(entry.providers) ? entry.providers : [];
        const providerWithContext = providers.find(
          (provider) => typeof provider?.context_length === "number" && provider.context_length > 0,
        );
        models.push({
          id,
          name,
          reasoning: inferred.reasoning,
          input,
          cost: HUGGINGFACE_DEFAULT_COST,
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
