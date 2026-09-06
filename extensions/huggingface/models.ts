import { withTrustedEnvProxyGuardedFetchMode } from "openclaw/plugin-sdk/fetch-runtime";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { buildLiveModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-types";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const HUGGINGFACE_MANIFEST_CATALOG = manifest.modelCatalog.providers.huggingface;
export const HUGGINGFACE_BASE_URL = HUGGINGFACE_MANIFEST_CATALOG.baseUrl;
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
    status?: string;
    context_length?: number;
    supports_tools?: boolean;
  }>;
};

type OpenAIListModelsResponse = {
  data?: HFModelEntry[];
};

export const HUGGINGFACE_MODEL_CATALOG: ModelDefinitionConfig[] = buildManifestModelProviderConfig({
  providerId: "huggingface",
  catalog: HUGGINGFACE_MANIFEST_CATALOG,
}).models;

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

function displayNameFromApiEntry(entry: HFModelEntry): string {
  const fromApi =
    (typeof entry.name === "string" && entry.name.trim()) ||
    (typeof entry.title === "string" && entry.title.trim()) ||
    (typeof entry.display_name === "string" && entry.display_name.trim());
  if (fromApi) {
    return fromApi;
  }
  const base = entry.id.split("/").pop() ?? entry.id;
  if (typeof entry.owned_by === "string" && entry.owned_by.trim()) {
    return `${entry.owned_by.trim()}/${base}`;
  }
  return base.replace(/-/g, " ").replace(/\b(\w)/g, (c) => c.toUpperCase());
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

    const modalities = entry?.architecture?.input_modalities;
    const providers = Array.isArray(entry?.providers)
      ? entry.providers.filter((provider) => provider?.status !== "error")
      : [];
    const providerContexts = providers
      .map((provider) => provider?.context_length)
      .filter((context): context is number => typeof context === "number" && context > 0);
    const model: ModelDefinitionConfig = catalogById.get(id) ?? {
      id,
      name: displayNameFromApiEntry(entry),
      reasoning: isReasoningModelHeuristic(id),
      input:
        Array.isArray(modalities) && modalities.includes("image") ? ["text", "image"] : ["text"],
      cost: HUGGINGFACE_DEFAULT_COST,
      contextWindow: HUGGINGFACE_DEFAULT_CONTEXT_WINDOW,
      maxTokens: HUGGINGFACE_DEFAULT_MAX_TOKENS,
    };
    models.push({
      ...model,
      contextWindow:
        providerContexts.length > 0 ? Math.min(...providerContexts) : model.contextWindow,
      ...(providers.some((provider) => provider?.supports_tools === false)
        ? { compat: { ...model.compat, supportsTools: false } }
        : {}),
    });
  }
  return models;
}

export async function discoverHuggingfaceModels(
  apiKey: string,
  timeoutMs = HUGGINGFACE_DISCOVERY_TIMEOUT_MS,
  options: { discoveryMode?: "strict" } = {},
): Promise<ModelDefinitionConfig[]> {
  const trimmedKey = apiKey?.trim();
  if (!trimmedKey) {
    return HUGGINGFACE_MODEL_CATALOG.map((model) => Object.assign({}, model));
  }

  const requestTimeoutMs = resolveTimerTimeoutMs(timeoutMs, HUGGINGFACE_DISCOVERY_TIMEOUT_MS);
  const provider = await buildLiveModelProviderConfig({
    ...options,
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
