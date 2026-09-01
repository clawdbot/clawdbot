// Kilocode provider module implements model/runtime integration.
import { buildLiveModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { ssrfPolicyFromHttpBaseUrlAllowedHostname } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asPositiveSafeInteger,
  normalizeLowercaseStringOrEmpty,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export const KILOCODE_BASE_URL = "https://api.kilo.ai/api/gateway/";
export const KILOCODE_DEFAULT_MODEL_ID = "kilo-auto/balanced";
export const KILOCODE_DEFAULT_MODEL_REF = `kilocode/${KILOCODE_DEFAULT_MODEL_ID}`;
export const KILOCODE_DEFAULT_MODEL_NAME = "Auto Balanced";

type KilocodeModelCatalogEntry = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
};

export const KILOCODE_MODEL_CATALOG: KilocodeModelCatalogEntry[] = [
  {
    id: KILOCODE_DEFAULT_MODEL_ID,
    name: KILOCODE_DEFAULT_MODEL_NAME,
    input: ["text", "image"],
    reasoning: true,
  },
];

export const KILOCODE_DEFAULT_CONTEXT_WINDOW = 1000000;
export const KILOCODE_DEFAULT_MAX_TOKENS = 65536;
export const KILOCODE_DEFAULT_COST = {
  input: 0.325,
  output: 1.95,
  cacheRead: 0.0325,
  cacheWrite: 0.40625,
};

export const KILOCODE_MODELS_URL = `${KILOCODE_BASE_URL}models`;

const DISCOVERY_TIMEOUT_MS = 5000;

interface GatewayModelPricing {
  prompt: string;
  completion: string;
  image?: string;
  request?: string;
  input_cache_read?: string;
  input_cache_write?: string;
  web_search?: string;
  internal_reasoning?: string;
}

interface GatewayModelEntry {
  id: string;
  name: string;
  context_length: number;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  top_provider?: {
    context_length?: number | null;
    max_completion_tokens?: number | null;
  };
  pricing: GatewayModelPricing;
  supported_parameters?: string[];
}

function toPricePerMillion(perToken: string | undefined, fallback = 0): number {
  const num = Number(perToken);
  return Number.isFinite(num) && num >= 0 ? num * 1_000_000 : fallback;
}

function parseModality(entry: GatewayModelEntry): Array<"text" | "image"> {
  const modalities = entry.architecture?.input_modalities;
  if (!Array.isArray(modalities)) {
    return ["text"];
  }
  const hasImage = modalities.some(
    (m) => typeof m === "string" && normalizeLowercaseStringOrEmpty(m) === "image",
  );
  return hasImage ? ["text", "image"] : ["text"];
}

function parseReasoning(entry: GatewayModelEntry): boolean {
  const params = entry.supported_parameters;
  if (!Array.isArray(params)) {
    return false;
  }
  return params.includes("reasoning") || params.includes("include_reasoning");
}

function toModelDefinition(entry: GatewayModelEntry): ModelDefinitionConfig {
  const fallbackCost = entry.id === KILOCODE_DEFAULT_MODEL_ID ? KILOCODE_DEFAULT_COST : undefined;
  return {
    id: entry.id,
    name: entry.name || entry.id,
    reasoning: parseReasoning(entry),
    input: parseModality(entry),
    cost: {
      input: toPricePerMillion(entry.pricing.prompt, fallbackCost?.input),
      output: toPricePerMillion(entry.pricing.completion, fallbackCost?.output),
      cacheRead: toPricePerMillion(entry.pricing.input_cache_read),
      cacheWrite: toPricePerMillion(entry.pricing.input_cache_write),
    },
    // The primary provider window bounds real requests; the catalog-wide value can be larger.
    contextWindow:
      asPositiveSafeInteger(entry.top_provider?.context_length) ??
      asPositiveSafeInteger(entry.context_length) ??
      KILOCODE_DEFAULT_CONTEXT_WINDOW,
    maxTokens:
      asPositiveSafeInteger(entry.top_provider?.max_completion_tokens) ??
      KILOCODE_DEFAULT_MAX_TOKENS,
  };
}

function buildStaticCatalog(): ModelDefinitionConfig[] {
  return KILOCODE_MODEL_CATALOG.map((model) => ({
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
    cost: KILOCODE_DEFAULT_COST,
    contextWindow: model.contextWindow ?? KILOCODE_DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? KILOCODE_DEFAULT_MAX_TOKENS,
  }));
}

function asGatewayModelEntry(value: unknown): GatewayModelEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Kilocode model list: malformed JSON response");
  }
  const entry = value as Partial<GatewayModelEntry>;
  if (
    typeof entry.id !== "string" ||
    typeof entry.pricing !== "object" ||
    entry.pricing === null ||
    Array.isArray(entry.pricing)
  ) {
    throw new Error("Kilocode model list: malformed JSON response");
  }
  return value as GatewayModelEntry;
}

function readGatewayModelId(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "";
  }
  const id = (value as Partial<GatewayModelEntry>).id;
  return typeof id === "string" ? id.trim() : "";
}

function readGatewayModelRows(body: unknown): readonly unknown[] {
  const data = (body as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data)) {
    throw new Error("Kilocode model list: malformed JSON response");
  }
  return data;
}

function projectKilocodeModels(rows: readonly unknown[]): ModelDefinitionConfig[] {
  const models: ModelDefinitionConfig[] = [];
  const discoveredIds = new Set<string>();
  for (const rawEntry of rows) {
    const id = readGatewayModelId(rawEntry);
    try {
      const entry = asGatewayModelEntry(rawEntry);
      if (
        !id ||
        discoveredIds.has(id) ||
        entry.architecture?.output_modalities?.includes("image")
      ) {
        continue;
      }
      models.push(toModelDefinition(entry));
      discoveredIds.add(id);
    } catch {
      // A malformed row must not hide a later valid row with the same id.
    }
  }
  for (const staticModel of buildStaticCatalog()) {
    if (!discoveredIds.has(staticModel.id)) {
      models.unshift(staticModel);
    }
  }
  return models;
}

export async function discoverKilocodeModels(): Promise<ModelDefinitionConfig[]> {
  const provider = await buildLiveModelProviderConfig({
    providerId: "kilocode",
    endpoint: KILOCODE_MODELS_URL,
    providerConfig: { baseUrl: KILOCODE_BASE_URL, api: "openai-completions" },
    models: buildStaticCatalog(),
    timeoutMs: DISCOVERY_TIMEOUT_MS,
    ttlMs: 0,
    readRows: readGatewayModelRows,
    buildRequestHeaders: () => ({ Accept: "application/json" }),
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(KILOCODE_BASE_URL),
    auditContext: "kilocode.model_discovery",
    projectRows: projectKilocodeModels,
  });
  return provider.models;
}

export function buildKilocodeModelDefinition(): ModelDefinitionConfig {
  return {
    id: KILOCODE_DEFAULT_MODEL_ID,
    name: KILOCODE_DEFAULT_MODEL_NAME,
    reasoning: true,
    input: ["text", "image"],
    cost: KILOCODE_DEFAULT_COST,
    contextWindow: KILOCODE_DEFAULT_CONTEXT_WINDOW,
    maxTokens: KILOCODE_DEFAULT_MAX_TOKENS,
  };
}
