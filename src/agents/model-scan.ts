import {
  type Context,
  complete,
  getEnvApiKey,
  getModel,
  type Model,
  type OpenAICompletionsOptions,
  type Tool,
} from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_CONCURRENCY = 3;

const BASE_IMAGE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X3mIAAAAASUVORK5CYII=";

const TOOL_PING: Tool = {
  name: "ping",
  description: "Return OK.",
  parameters: Type.Object({}),
};

type OpenRouterModelMeta = {
  id: string;
  name: string;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  supportedParameters: string[];
  supportedParametersCount: number;
  supportsToolsMeta: boolean;
  modality: string | null;
  inferredParamB: number | null;
  createdAtMs: number | null;
  pricing: OpenRouterModelPricing | null;
};

type OpenRouterModelPricing = {
  prompt: number;
  completion: number;
  request: number;
  image: number;
  webSearch: number;
  internalReasoning: number;
};

export type ProbeResult = {
  ok: boolean;
  latencyMs: number | null;
  error?: string;
  skipped?: boolean;
};

export type ModelScanResult = {
  id: string;
  name: string;
  provider: string;
  modelRef: string;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  supportedParametersCount: number;
  supportsToolsMeta: boolean;
  modality: string | null;
  inferredParamB: number | null;
  createdAtMs: number | null;
  pricing: OpenRouterModelPricing | null;
  isFree: boolean;
  tool: ProbeResult;
  image: ProbeResult;
};

export type OpenRouterScanOptions = {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  concurrency?: number;
  minParamB?: number;
  maxAgeDays?: number;
  providerFilter?: string;
  probe?: boolean;
  onProgress?: (update: {
    phase: "catalog" | "probe";
    completed: number;
    total: number;
  }) => void;
};

type OpenAIModel = Model<"openai-completions">;

function normalizeCreatedAtMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= 0) return null;
  if (value > 1e12) return Math.round(value);
  return Math.round(value * 1000);
}

function inferParamBFromIdOrName(text: string): number | null {
  const raw = text.toLowerCase();
  const matches = raw.matchAll(
    /(?:^|[^a-z0-9])[a-z]?(\d+(?:\.\d+)?)b(?:[^a-z0-9]|$)/g,
  );
  let best: number | null = null;
  for (const match of matches) {
    const numRaw = match[1];
    if (!numRaw) continue;
    const value = Number(numRaw);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (best === null || value > best) best = value;
  }
  return best;
}

function parseModality(modality: string | null): Array<"text" | "image"> {
  if (!modality) return ["text"];
  const normalized = modality.toLowerCase();
  const parts = normalized.split(/[^a-z]+/).filter(Boolean);
  const hasImage = parts.includes("image");
  return hasImage ? ["text", "image"] : ["text"];
}

function parseNumberString(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return null;
  return num;
}

function parseOpenRouterPricing(value: unknown): OpenRouterModelPricing | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const prompt = parseNumberString(obj.prompt);
  const completion = parseNumberString(obj.completion);
  const request = parseNumberString(obj.request) ?? 0;
  const image = parseNumberString(obj.image) ?? 0;
  const webSearch = parseNumberString(obj.web_search) ?? 0;
  const internalReasoning = parseNumberString(obj.internal_reasoning) ?? 0;

  if (prompt === null || completion === null) return null;
  return {
    prompt,
    completion,
    request,
    image,
    webSearch,
    internalReasoning,
  };
}

function isFreeOpenRouterModel(entry: OpenRouterModelMeta): boolean {
  if (entry.id.endsWith(":free")) return true;
  if (!entry.pricing) return false;
  return entry.pricing.prompt === 0 && entry.pricing.completion === 0;
}

async function withTimeout<T>(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOpenRouterModels(
  fetchImpl: typeof fetch,
): Promise<OpenRouterModelMeta[]> {
  const res = await fetchImpl(OPENROUTER_MODELS_URL, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`OpenRouter /models failed: HTTP ${res.status}`);
  }
  const payload = (await res.json()) as { data?: unknown };
  const entries = Array.isArray(payload.data) ? payload.data : [];

  return entries
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const obj = entry as Record<string, unknown>;
      const id = typeof obj.id === "string" ? obj.id.trim() : "";
      if (!id) return null;
      const name =
        typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : id;

      const contextLength =
        typeof obj.context_length === "number" &&
        Number.isFinite(obj.context_length)
          ? obj.context_length
          : null;

      const maxCompletionTokens =
        typeof obj.max_completion_tokens === "number" &&
        Number.isFinite(obj.max_completion_tokens)
          ? obj.max_completion_tokens
          : typeof obj.max_output_tokens === "number" &&
              Number.isFinite(obj.max_output_tokens)
            ? obj.max_output_tokens
            : null;

      const supportedParameters = Array.isArray(obj.supported_parameters)
        ? obj.supported_parameters
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter(Boolean)
        : [];

      const supportedParametersCount = supportedParameters.length;
      const supportsToolsMeta = supportedParameters.includes("tools");

      const modality =
        typeof obj.modality === "string" && obj.modality.trim()
          ? obj.modality.trim()
          : null;

      const inferredParamB = inferParamBFromIdOrName(`${id} ${name}`);
      const createdAtMs = normalizeCreatedAtMs(obj.created_at);
      const pricing = parseOpenRouterPricing(obj.pricing);

      return {
        id,
        name,
        contextLength,
        maxCompletionTokens,
        supportedParameters,
        supportedParametersCount,
        supportsToolsMeta,
        modality,
        inferredParamB,
        createdAtMs,
        pricing,
      } satisfies OpenRouterModelMeta;
    })
    .filter((entry): entry is OpenRouterModelMeta => Boolean(entry));
}

async function probeTool(
  model: OpenAIModel,
  apiKey: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  const context: Context = {
    messages: [
      {
        role: "user",
        content: "Call the ping tool with {} and nothing else.",
        timestamp: Date.now(),
      },
    ],
    tools: [TOOL_PING],
  };
  const startedAt = Date.now();
  try {
    const message = await withTimeout(timeoutMs, (signal) =>
      complete(model, context, {
        apiKey,
        maxTokens: 32,
        temperature: 0,
        toolChoice: "required",
        signal,
      } satisfies OpenAICompletionsOptions),
    );

    const hasToolCall = message.content.some(
      (block) => block.type === "toolCall",
    );
    if (!hasToolCall) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: "No tool call returned",
      };
    }

    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeImage(
  model: OpenAIModel,
  apiKey: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  const context: Context = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Reply with OK." },
          { type: "image", data: BASE_IMAGE_PNG, mimeType: "image/png" },
        ],
        timestamp: Date.now(),
      },
    ],
  };
  const startedAt = Date.now();
  try {
    await withTimeout(timeoutMs, (signal) =>
      complete(model, context, {
        apiKey,
        maxTokens: 16,
        temperature: 0,
        signal,
      } satisfies OpenAICompletionsOptions),
    );
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function ensureImageInput(model: OpenAIModel): OpenAIModel {
  if (model.input.includes("image")) return model;
  return {
    ...model,
    input: Array.from(new Set([...model.input, "image"])),
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  opts?: { onProgress?: (completed: number, total: number) => void },
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results = Array.from({ length: items.length }) as R[];
  let nextIndex = 0;
  let completed = 0;

  const worker = async () => {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await fn(items[current] as T, current);
      completed += 1;
      opts?.onProgress?.(completed, items.length);
    }
  };

  if (items.length === 0) {
    opts?.onProgress?.(0, 0);
    return results;
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

export async function scanOpenRouterModels(
  options: OpenRouterScanOptions = {},
): Promise<ModelScanResult[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const probe = options.probe ?? true;
  const apiKey = options.apiKey?.trim() || getEnvApiKey("openrouter") || "";
  if (probe && !apiKey) {
    throw new Error(
      "Missing OpenRouter API key. Set OPENROUTER_API_KEY to run models scan.",
    );
  }

  const timeoutMs = Math.max(
    1,
    Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  );
  const concurrency = Math.max(
    1,
    Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY),
  );
  const minParamB = Math.max(0, Math.floor(options.minParamB ?? 0));
  const maxAgeDays = Math.max(0, Math.floor(options.maxAgeDays ?? 0));
  const providerFilter = options.providerFilter?.trim().toLowerCase() ?? "";

  const catalog = await fetchOpenRouterModels(fetchImpl);
  const now = Date.now();

  const filtered = catalog.filter((entry) => {
    if (!isFreeOpenRouterModel(entry)) return false;
    if (providerFilter) {
      const prefix = entry.id.split("/")[0]?.toLowerCase() ?? "";
      if (prefix !== providerFilter) return false;
    }
    if (minParamB > 0) {
      const params = entry.inferredParamB ?? 0;
      if (params < minParamB) return false;
    }
    if (maxAgeDays > 0 && entry.createdAtMs) {
      const ageMs = now - entry.createdAtMs;
      const ageDays = ageMs / (24 * 60 * 60 * 1000);
      if (ageDays > maxAgeDays) return false;
    }
    return true;
  });

  const baseModel = getModel("openrouter", "openrouter/auto") as OpenAIModel;

  options.onProgress?.({
    phase: "probe",
    completed: 0,
    total: filtered.length,
  });

  return mapWithConcurrency(
    filtered,
    concurrency,
    async (entry) => {
      const isFree = isFreeOpenRouterModel(entry);
      if (!probe) {
        return {
          id: entry.id,
          name: entry.name,
          provider: "openrouter",
          modelRef: `openrouter/${entry.id}`,
          contextLength: entry.contextLength,
          maxCompletionTokens: entry.maxCompletionTokens,
          supportedParametersCount: entry.supportedParametersCount,
          supportsToolsMeta: entry.supportsToolsMeta,
          modality: entry.modality,
          inferredParamB: entry.inferredParamB,
          createdAtMs: entry.createdAtMs,
          pricing: entry.pricing,
          isFree,
          tool: { ok: false, latencyMs: null, skipped: true },
          image: { ok: false, latencyMs: null, skipped: true },
        } satisfies ModelScanResult;
      }

      const model: OpenAIModel = {
        ...baseModel,
        id: entry.id,
        name: entry.name || entry.id,
        contextWindow: entry.contextLength ?? baseModel.contextWindow,
        maxTokens: entry.maxCompletionTokens ?? baseModel.maxTokens,
        input: parseModality(entry.modality),
        reasoning: baseModel.reasoning,
      };

      const toolResult = await probeTool(model, apiKey, timeoutMs);
      const imageResult = model.input.includes("image")
        ? await probeImage(ensureImageInput(model), apiKey, timeoutMs)
        : { ok: false, latencyMs: null, skipped: true };

      return {
        id: entry.id,
        name: entry.name,
        provider: "openrouter",
        modelRef: `openrouter/${entry.id}`,
        contextLength: entry.contextLength,
        maxCompletionTokens: entry.maxCompletionTokens,
        supportedParametersCount: entry.supportedParametersCount,
        supportsToolsMeta: entry.supportsToolsMeta,
        modality: entry.modality,
        inferredParamB: entry.inferredParamB,
        createdAtMs: entry.createdAtMs,
        pricing: entry.pricing,
        isFree,
        tool: toolResult,
        image: imageResult,
      } satisfies ModelScanResult;
    },
    {
      onProgress: (completed, total) =>
        options.onProgress?.({
          phase: "probe",
          completed,
          total,
        }),
    },
  );
}

export { OPENROUTER_MODELS_URL };
export type { OpenRouterModelMeta, OpenRouterModelPricing };
