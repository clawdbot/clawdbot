/**
 * OpenRouter live model catalog adapter.
 *
 * Fetches the public /api/v1/models catalog and normalizes provider/model
 * metadata into the Personal AI OS smart-router candidate shape.
 */
import type { ModelCatalogEntry, ModelInputType } from "./model-catalog.types.js";
import type { ModelTask, SmartModelCandidate } from "./smart-model-router.js";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

export type OpenRouterModel = {
  id?: unknown;
  canonical_slug?: unknown;
  name?: unknown;
  description?: unknown;
  architecture?: { input_modalities?: unknown };
  pricing?: { prompt?: unknown; completion?: unknown };
  top_provider?: { context_length?: unknown };
  context_length?: unknown;
  supported_parameters?: unknown;
};

export type OpenRouterModelsResponse = { data?: unknown };

export type OpenRouterCatalogOptions = {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
};

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function isZeroPrice(value: unknown): boolean {
  return numberValue(value) === 0 || value === "0" || value === "0.0";
}

function isFreeModel(model: OpenRouterModel): boolean {
  const id = stringValue(model.id) ?? "";
  return id.endsWith(":free") ||
    (isZeroPrice(model.pricing?.prompt) && isZeroPrice(model.pricing?.completion));
}

function hasParameter(model: OpenRouterModel, parameter: string): boolean {
  return stringArray(model.supported_parameters).includes(parameter);
}

function inferInput(model: OpenRouterModel): ModelInputType[] {
  const raw = stringArray(model.architecture?.input_modalities);
  if (!raw.length) return ["text"];
  return raw.filter((item): item is ModelInputType =>
    ["text", "image", "audio", "video", "document"].includes(item),
  );
}

function inferCapabilities(model: OpenRouterModel): Partial<Record<ModelTask, number>> {
  const name = `${stringValue(model.id) ?? ""} ${stringValue(model.name) ?? ""} ${stringValue(model.description) ?? ""}`.toLowerCase();
  const tools = hasParameter(model, "tools") || hasParameter(model, "tool_choice");
  const structured = hasParameter(model, "response_format") || hasParameter(model, "structured_outputs");
  const reasoning = hasParameter(model, "reasoning") || /reason|thinking|qwq|r\d|o[1-9]/.test(name);
  const coding = /code|coder|coding|dev|program|software|qwen3-coder/.test(name);
  const vision = inferInput(model).includes("image");
  const context = numberValue(model.top_provider?.context_length) ?? numberValue(model.context_length) ?? 0;
  const fast = /flash|nano|mini|small|lite|haiku/.test(name);

  return {
    chat: 0.75,
    coding: coding ? 0.95 : 0.65,
    debugging: coding ? 0.9 : 0.65,
    reasoning: reasoning ? 0.95 : 0.7,
    research: reasoning ? 0.9 : 0.7,
    writing: 0.8,
    summarization: 0.8,
    ...(vision ? { vision: 0.95 } : {}),
    ...(tools ? { "tool-use": 0.95, browser: 0.9 } : {}),
    ...(structured ? { "structured-output": 0.95 } : {}),
    ...(context >= 100_000 ? { "long-context": 0.95 } : {}),
    fast: fast ? 0.9 : 0.65,
    "data-analysis": reasoning ? 0.85 : 0.7,
    planning: reasoning ? 0.9 : 0.7,
  };
}

export function normalizeOpenRouterModel(model: OpenRouterModel): {
  catalog: ModelCatalogEntry;
  candidate: SmartModelCandidate;
} | undefined {
  const id = stringValue(model.id);
  if (!id) return undefined;

  const free = isFreeModel(model);
  const contextWindow = numberValue(model.top_provider?.context_length) ?? numberValue(model.context_length);
  const input = inferInput(model);
  const supportsTools = hasParameter(model, "tools") || hasParameter(model, "tool_choice");
  const supportsVision = input.includes("image");
  const reasoning = hasParameter(model, "reasoning") || /reason|thinking|qwq|r1|o[1-9]/i.test(id);
  const name = stringValue(model.name) ?? id;

  const catalog: ModelCatalogEntry = {
    id,
    name,
    provider: "openrouter",
    contextWindow,
    contextTokens: contextWindow,
    reasoning,
    input,
    params: {
      openrouter: {
        canonicalSlug: stringValue(model.canonical_slug),
        free,
        supportedParameters: stringArray(model.supported_parameters),
      },
    },
  };

  const candidate: SmartModelCandidate = {
    provider: "openrouter",
    model: id,
    free,
    available: true,
    capabilities: inferCapabilities(model),
    contextWindow,
    supportsTools,
    supportsVision,
  };

  return { catalog, candidate };
}

export async function fetchOpenRouterModels(
  options: OpenRouterCatalogOptions = {},
): Promise<OpenRouterModel[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("OpenRouter catalog requires fetch");

  const timeoutMs = options.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal ?? controller.signal;

  try {
    const response = await fetchImpl(OPENROUTER_MODELS_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) {
      throw new Error(`OpenRouter model catalog request failed: HTTP ${response.status}`);
    }
    const payload = (await response.json()) as OpenRouterModelsResponse;
    if (!Array.isArray(payload.data)) {
      throw new Error("OpenRouter model catalog response is missing data[]");
    }
    return payload.data.filter((item): item is OpenRouterModel => !!item && typeof item === "object");
  } finally {
    clearTimeout(timer);
  }
}

export async function buildOpenRouterCatalog(
  options: OpenRouterCatalogOptions = {},
): Promise<{ entries: ModelCatalogEntry[]; candidates: SmartModelCandidate[] }> {
  const models = await fetchOpenRouterModels(options);
  const normalized = models.map(normalizeOpenRouterModel).filter(Boolean) as Array<{
    catalog: ModelCatalogEntry;
    candidate: SmartModelCandidate;
  }>;
  return {
    entries: normalized.map((item) => item.catalog),
    candidates: normalized.map((item) => item.candidate),
  };
}
