import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";

export const XAI_BASE_URL = "https://api.x.ai/v1";
export const XAI_DEFAULT_IMAGE_MODEL = "grok-imagine-image";
export const XAI_IMAGE_MODELS = ["grok-imagine-image", "grok-imagine-image-pro"] as const;
export const XAI_DEFAULT_CONTEXT_WINDOW = 1_000_000;
const XAI_LARGE_CONTEXT_WINDOW = 2_000_000;
const XAI_GROK_4_CONTEXT_WINDOW = 256_000;
const XAI_CODE_CONTEXT_WINDOW = 256_000;
export const XAI_DEFAULT_MAX_TOKENS = 64_000;
const XAI_LEGACY_CONTEXT_WINDOW = 131_072;
const XAI_LEGACY_MAX_TOKENS = 8_192;
export const XAI_DEFAULT_MODEL_ID = "grok-4.3";
export const XAI_DEFAULT_MODEL_REF = `xai/${XAI_DEFAULT_MODEL_ID}`;

type XaiCost = ModelDefinitionConfig["cost"];

type XaiCatalogEntry = {
  id: string;
  name: string;
  reasoning: boolean;
  input?: ModelDefinitionConfig["input"];
  contextWindow: number;
  maxTokens?: number;
  cost: XaiCost;
};

const XAI_GROK_4_COST = {
  input: 3,
  output: 15,
  cacheRead: 0.75,
  cacheWrite: 0,
} satisfies XaiCost;

const XAI_FAST_COST = {
  input: 0.2,
  output: 0.5,
  cacheRead: 0.05,
  cacheWrite: 0,
} satisfies XaiCost;

const XAI_GROK_420_COST = {
  input: 2,
  output: 6,
  cacheRead: 0.2,
  cacheWrite: 0,
} satisfies XaiCost;

const XAI_GROK_43_COST = {
  input: 1.25,
  output: 2.5,
  cacheRead: 0.2,
  cacheWrite: 0,
} satisfies XaiCost;

const XAI_CODE_FAST_COST = {
  input: 0.2,
  output: 1.5,
  cacheRead: 0.02,
  cacheWrite: 0,
} satisfies XaiCost;

const XAI_MODEL_CATALOG = [
  {
    id: "grok-3",
    name: "Grok 3",
    reasoning: false,
    input: ["text"],
    contextWindow: XAI_LEGACY_CONTEXT_WINDOW,
    maxTokens: XAI_LEGACY_MAX_TOKENS,
    cost: XAI_GROK_4_COST,
  },
  {
    id: "grok-3-fast",
    name: "Grok 3 Fast",
    reasoning: false,
    input: ["text"],
    contextWindow: XAI_LEGACY_CONTEXT_WINDOW,
    maxTokens: XAI_LEGACY_MAX_TOKENS,
    cost: { input: 5, output: 25, cacheRead: 1.25, cacheWrite: 0 },
  },
  {
    id: "grok-3-mini",
    name: "Grok 3 Mini",
    reasoning: true,
    input: ["text"],
    contextWindow: XAI_LEGACY_CONTEXT_WINDOW,
    maxTokens: XAI_LEGACY_MAX_TOKENS,
    cost: { input: 0.3, output: 0.5, cacheRead: 0.075, cacheWrite: 0 },
  },
  {
    id: "grok-3-mini-fast",
    name: "Grok 3 Mini Fast",
    reasoning: true,
    input: ["text"],
    contextWindow: XAI_LEGACY_CONTEXT_WINDOW,
    maxTokens: XAI_LEGACY_MAX_TOKENS,
    cost: { input: 0.6, output: 4, cacheRead: 0.15, cacheWrite: 0 },
  },
  {
    id: "grok-4.3",
    name: "Grok 4.3",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: XAI_DEFAULT_MAX_TOKENS,
    cost: XAI_GROK_43_COST,
  },
  {
    id: "grok-4",
    name: "Grok 4",
    reasoning: true,
    input: ["text"],
    contextWindow: XAI_GROK_4_CONTEXT_WINDOW,
    maxTokens: XAI_DEFAULT_MAX_TOKENS,
    cost: XAI_GROK_4_COST,
  },
  {
    id: "grok-4-0709",
    name: "Grok 4 0709",
    reasoning: false,
    input: ["text"],
    contextWindow: XAI_GROK_4_CONTEXT_WINDOW,
    maxTokens: XAI_DEFAULT_MAX_TOKENS,
    cost: XAI_GROK_4_COST,
  },
  {
    id: "grok-4-fast",
    name: "Grok 4 Fast",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: XAI_LARGE_CONTEXT_WINDOW,
    maxTokens: 30_000,
    cost: XAI_FAST_COST,
  },
  {
    id: "grok-4-fast-non-reasoning",
    name: "Grok 4 Fast (Non-Reasoning)",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: XAI_LARGE_CONTEXT_WINDOW,
    maxTokens: 30_000,
    cost: XAI_FAST_COST,
  },
  {
    id: "grok-4-1-fast",
    name: "Grok 4.1 Fast",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: XAI_LARGE_CONTEXT_WINDOW,
    maxTokens: 30_000,
    cost: XAI_FAST_COST,
  },
  {
    id: "grok-4-1-fast-non-reasoning",
    name: "Grok 4.1 Fast (Non-Reasoning)",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: XAI_LARGE_CONTEXT_WINDOW,
    maxTokens: 30_000,
    cost: XAI_FAST_COST,
  },
  {
    id: "grok-4.20-beta-latest-reasoning",
    name: "Grok 4.20 Beta Latest (Reasoning)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: XAI_LARGE_CONTEXT_WINDOW,
    maxTokens: 30_000,
    cost: XAI_GROK_420_COST,
  },
  {
    id: "grok-4.20-beta-latest-non-reasoning",
    name: "Grok 4.20 Beta Latest (Non-Reasoning)",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: XAI_LARGE_CONTEXT_WINDOW,
    maxTokens: 30_000,
    cost: XAI_GROK_420_COST,
  },
  {
    id: "grok-code-fast-1",
    name: "Grok Code Fast 1",
    reasoning: true,
    input: ["text"],
    contextWindow: XAI_CODE_CONTEXT_WINDOW,
    maxTokens: 10_000,
    cost: XAI_CODE_FAST_COST,
  },
] as const satisfies readonly XaiCatalogEntry[];

function toModelDefinition(entry: XaiCatalogEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: entry.input ?? ["text"],
    cost: entry.cost,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens ?? XAI_DEFAULT_MAX_TOKENS,
  };
}

export function buildXaiModelDefinition(): ModelDefinitionConfig {
  return toModelDefinition(
    XAI_MODEL_CATALOG.find((entry) => entry.id === XAI_DEFAULT_MODEL_ID) ?? {
      id: XAI_DEFAULT_MODEL_ID,
      name: "Grok 4.3",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
      maxTokens: XAI_DEFAULT_MAX_TOKENS,
      cost: XAI_GROK_43_COST,
    },
  );
}

export function buildXaiCatalogModels(): ModelDefinitionConfig[] {
  return XAI_MODEL_CATALOG.map((entry) => toModelDefinition(entry));
}

export function resolveXaiCatalogEntry(modelId: string) {
  const trimmed = modelId.trim();
  const lower = normalizeOptionalLowercaseString(modelId) ?? "";
  const exact = XAI_MODEL_CATALOG.find(
    (entry) => normalizeOptionalLowercaseString(entry.id) === lower,
  );
  if (exact) {
    return toModelDefinition(exact);
  }
  if (lower.includes("multi-agent")) {
    return undefined;
  }
  if (lower.startsWith("grok-code-fast")) {
    return toModelDefinition({
      id: trimmed,
      name: trimmed,
      reasoning: true,
      input: ["text"],
      contextWindow: XAI_CODE_CONTEXT_WINDOW,
      maxTokens: 10_000,
      cost: XAI_CODE_FAST_COST,
    });
  }
  if (
    lower.startsWith("grok-3-mini-fast") ||
    lower.startsWith("grok-3-mini") ||
    lower.startsWith("grok-3-fast") ||
    lower.startsWith("grok-3")
  ) {
    const legacyCost = lower.startsWith("grok-3-mini-fast")
      ? { input: 0.6, output: 4, cacheRead: 0.15, cacheWrite: 0 }
      : lower.startsWith("grok-3-mini")
        ? { input: 0.3, output: 0.5, cacheRead: 0.075, cacheWrite: 0 }
        : lower.startsWith("grok-3-fast")
          ? { input: 5, output: 25, cacheRead: 1.25, cacheWrite: 0 }
          : XAI_GROK_4_COST;
    return toModelDefinition({
      id: trimmed,
      name: trimmed,
      reasoning: lower.includes("mini"),
      input: ["text"],
      contextWindow: XAI_LEGACY_CONTEXT_WINDOW,
      maxTokens: XAI_LEGACY_MAX_TOKENS,
      cost: legacyCost,
    });
  }
  if (
    lower.startsWith("grok-4.3") ||
    lower.startsWith("grok-4.20") ||
    lower.startsWith("grok-4-1") ||
    lower.startsWith("grok-4-fast")
  ) {
    return toModelDefinition({
      id: trimmed,
      name: trimmed,
      reasoning: !lower.includes("non-reasoning"),
      input: ["text", "image"],
      contextWindow: lower.startsWith("grok-4.3")
        ? XAI_DEFAULT_CONTEXT_WINDOW
        : XAI_LARGE_CONTEXT_WINDOW,
      maxTokens: lower.startsWith("grok-4.3") ? XAI_DEFAULT_MAX_TOKENS : 30_000,
      cost: lower.startsWith("grok-4.3")
        ? XAI_GROK_43_COST
        : lower.startsWith("grok-4.20")
          ? XAI_GROK_420_COST
          : XAI_FAST_COST,
    });
  }
  if (lower.startsWith("grok-4")) {
    return toModelDefinition({
      id: modelId.trim(),
      name: modelId.trim(),
      reasoning: lower.includes("reasoning"),
      input: ["text"],
      contextWindow: XAI_GROK_4_CONTEXT_WINDOW,
      maxTokens: XAI_DEFAULT_MAX_TOKENS,
      cost: XAI_GROK_4_COST,
    });
  }
  return undefined;
}
