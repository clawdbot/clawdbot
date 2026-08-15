// Huggingface plugin module implements models behavior.
import { withTrustedEnvProxyGuardedFetchMode } from "openclaw/plugin-sdk/fetch-runtime";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { buildLiveModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-types";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export const HUGGINGFACE_BASE_URL = "https://router.huggingface.co/v1";
export const HUGGINGFACE_POLICY_SUFFIXES = ["cheapest", "fastest"] as const;
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

function readHuggingfaceModelRows(body: unknown): readonly unknown[] {
  const data = (body as OpenAIListModelsResponse | undefined)?.data;
  if (!Array.isArray(data)) {
    throw new Error("Hugging Face model discovery response must contain a data array");
  }
  return data;
}

function projectHuggingfaceModels(rows: readonly unknown[]): ModelDefinitionConfig[] {
  const catalogById = new Map(HUGGINGFACE_MODEL_CATALOG.map((model) => [model.id, model] as const));
  const seen = new Set<string>();
  const models: ModelDefinitionConfig[] = [];
  for (const row of rows) {
    const entry = row as HFModelEntry | undefined;
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!entry || !id || seen.has(id)) {
      continue;
    }
    seen.add(id);

    const catalogEntry = catalogById.get(id);
    if (catalogEntry) {
      models.push(Object.assign({}, catalogEntry));
      continue;
    }

    const inferred = inferredMetaFromModelId(id);
    const modalities = entry?.architecture?.input_modalities;
    const providers = Array.isArray(entry?.providers) ? entry.providers : [];
    const providerWithContext = providers.find(
      (provider) => typeof provider?.context_length === "number" && provider.context_length > 0,
    );
    models.push({
      id,
      name: displayNameFromApiEntry(entry, inferred.name),
      reasoning: inferred.reasoning,
      input:
        Array.isArray(modalities) && modalities.includes("image") ? ["text", "image"] : ["text"],
      cost: HUGGINGFACE_DEFAULT_COST,
      contextWindow: providerWithContext?.context_length ?? HUGGINGFACE_DEFAULT_CONTEXT_WINDOW,
      maxTokens: HUGGINGFACE_DEFAULT_MAX_TOKENS,
    });
  }
  return models;
}

export async function discoverHuggingfaceModels(
  apiKey: string,
  timeoutMs = HUGGINGFACE_DISCOVERY_TIMEOUT_MS,
): Promise<ModelDefinitionConfig[]> {
  const trimmedKey = apiKey?.trim();
  if (!trimmedKey) {
    return HUGGINGFACE_MODEL_CATALOG.map((model) => Object.assign({}, model));
  }

  const requestTimeoutMs = resolveTimerTimeoutMs(timeoutMs, HUGGINGFACE_DISCOVERY_TIMEOUT_MS);
  const provider = await buildLiveModelProviderConfig({
    providerId: "huggingface",
    endpoint: `${HUGGINGFACE_BASE_URL}/models`,
    providerConfig: { baseUrl: HUGGINGFACE_BASE_URL, api: "openai-completions" },
    models: HUGGINGFACE_MODEL_CATALOG.map((model) => Object.assign({}, model)),
    discoveryApiKey: trimmedKey,
    signal: AbortSignal.timeout(requestTimeoutMs),
    timeoutMs: requestTimeoutMs,
    ttlMs: 0,
    readRows: readHuggingfaceModelRows,
    buildRequestHeaders: () => ({
      Authorization: `Bearer ${trimmedKey}`,
      "Content-Type": "application/json",
    }),
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(HUGGINGFACE_BASE_URL),
    auditContext: "huggingface-model-discovery",
    fetchGuard: (params) => fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode(params)),
    projectRows: projectHuggingfaceModels,
  });
  return provider.models;
}
