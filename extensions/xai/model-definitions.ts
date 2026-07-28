// Xai plugin module implements model definitions behavior.
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeXaiModelId } from "./model-id.js";

export const XAI_BASE_URL = "https://api.x.ai/v1";
export const XAI_DEFAULT_IMAGE_MODEL = "grok-imagine-image";
export const XAI_IMAGE_MODELS = ["grok-imagine-image", "grok-imagine-image-quality"] as const;
export const XAI_DEFAULT_CONTEXT_WINDOW = 1_000_000;
const XAI_GROK_45_CONTEXT_WINDOW = 500_000;
const XAI_CODE_CONTEXT_WINDOW = 256_000;
export const XAI_DEFAULT_MAX_TOKENS = 64_000;
export const XAI_DEFAULT_MODEL_ID = "grok-4.3";

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

const XAI_GROK_420_COST = {
  input: 1.25,
  output: 2.5,
  cacheRead: 0.2,
  cacheWrite: 0,
} satisfies XaiCost;

const XAI_GROK_43_COST = {
  input: 1.25,
  output: 2.5,
  cacheRead: 0.2,
  cacheWrite: 0,
} satisfies XaiCost;

const XAI_GROK_45_COST = {
  input: 2,
  output: 6,
  cacheRead: 0.5,
  cacheWrite: 0,
} satisfies XaiCost;

const XAI_GROK_BUILD_COST = {
  input: 1,
  output: 2,
  cacheRead: 0.2,
  cacheWrite: 0,
} satisfies XaiCost;

const XAI_MODEL_CATALOG = [
  {
    id: "grok-4.5",
    name: "Grok 4.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: XAI_GROK_45_CONTEXT_WINDOW,
    maxTokens: XAI_DEFAULT_MAX_TOKENS,
    cost: XAI_GROK_45_COST,
  },
  {
    id: "grok-build-0.1",
    name: "Grok Build 0.1",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: XAI_CODE_CONTEXT_WINDOW,
    cost: XAI_GROK_BUILD_COST,
  },
  {
    id: "grok-3",
    name: "Grok 3",
    reasoning: false,
    input: ["text"],
    contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: XAI_DEFAULT_MAX_TOKENS,
    cost: XAI_GROK_43_COST,
  },
  {
    id: "grok-3-fast",
    name: "Grok 3 Fast",
    reasoning: false,
    input: ["text"],
    contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: XAI_DEFAULT_MAX_TOKENS,
    cost: XAI_GROK_43_COST,
  },
  {
    id: "grok-3-mini",
    name: "Grok 3 Mini",
    reasoning: true,
    input: ["text"],
    contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: XAI_DEFAULT_MAX_TOKENS,
    cost: XAI_GROK_43_COST,
  },
  {
    id: "grok-3-mini-fast",
    name: "Grok 3 Mini Fast",
    reasoning: true,
    input: ["text"],
    contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: XAI_DEFAULT_MAX_TOKENS,
    cost: XAI_GROK_43_COST,
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
    contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: XAI_DEFAULT_MAX_TOKENS,
    cost: XAI_GROK_43_COST,
  },
  {
    id: "grok-4-0709",
    name: "Grok 4 0709",
    reasoning: true,
    input: ["text"],
    contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: XAI_DEFAULT_MAX_TOKENS,
    cost: XAI_GROK_43_COST,
  },
  {
    id: "grok-4-fast",
    name: "Grok 4 Fast",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: XAI_DEFAULT_MAX_TOKENS,
    cost: XAI_GROK_43_COST,
  },
  {
    id: "grok-4-fast-non-reasoning",
    name: "Grok 4 Fast (Non-Reasoning)",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: XAI_DEFAULT_MAX_TOKENS,
    cost: XAI_GROK_43_COST,
  },
  {
    id: "grok-4-1-fast",
    name: "Grok 4.1 Fast",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: XAI_DEFAULT_MAX_TOKENS,
    cost: XAI_GROK_43_COST,
  },
  {
    id: "grok-4-1-fast-non-reasoning",
    name: "Grok 4.1 Fast (Non-Reasoning)",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: XAI_DEFAULT_MAX_TOKENS,
    cost: XAI_GROK_43_COST,
  },
  {
    id: "grok-4.20-0309-reasoning",
    name: "Grok 4.20 0309 (Reasoning)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: 30_000,
    cost: XAI_GROK_420_COST,
  },
  {
    id: "grok-4.20-0309-non-reasoning",
    name: "Grok 4.20 0309 (Non-Reasoning)",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: 30_000,
    cost: XAI_GROK_420_COST,
  },
] as const satisfies readonly XaiCatalogEntry[];

const XAI_SELECTABLE_MODEL_IDS = new Set<string>([
  "grok-4.5",
  "grok-build-0.1",
  "grok-4.3",
  "grok-4.20-0309-reasoning",
  "grok-4.20-0309-non-reasoning",
]);

type LegacyXaiBuiltinSignature = readonly [
  name: string,
  reasoning: boolean,
  input: string,
  contextWindow: number,
  maxTokens: number,
  inputCost: number,
  outputCost: number,
  cacheReadCost: number,
  cacheWriteCost: number,
];

const LEGACY_XAI_BUILTIN_SIGNATURES = {
  "grok-3": ["Grok 3", false, "text", 131_072, 8_192, 3, 15, 0.75, 0],
  "grok-3-fast": ["Grok 3 Fast", false, "text", 131_072, 8_192, 5, 25, 1.25, 0],
  "grok-3-mini": ["Grok 3 Mini", true, "text", 131_072, 8_192, 0.3, 0.5, 0.075, 0],
  "grok-3-mini-fast": ["Grok 3 Mini Fast", true, "text", 131_072, 8_192, 0.6, 4, 0.15, 0],
  "grok-4": ["Grok 4", true, "text", 256_000, 64_000, 3, 15, 0.75, 0],
  "grok-4-0709": ["Grok 4 0709", false, "text", 256_000, 64_000, 3, 15, 0.75, 0],
  "grok-4-fast": ["Grok 4 Fast", true, "text,image", 2_000_000, 30_000, 0.2, 0.5, 0.05, 0],
  "grok-4-fast-non-reasoning": [
    "Grok 4 Fast (Non-Reasoning)",
    false,
    "text,image",
    2_000_000,
    30_000,
    0.2,
    0.5,
    0.05,
    0,
  ],
  "grok-4-1-fast": ["Grok 4.1 Fast", true, "text,image", 2_000_000, 30_000, 0.2, 0.5, 0.05, 0],
  "grok-4-1-fast-non-reasoning": [
    "Grok 4.1 Fast (Non-Reasoning)",
    false,
    "text,image",
    2_000_000,
    30_000,
    0.2,
    0.5,
    0.05,
    0,
  ],
} satisfies Record<string, LegacyXaiBuiltinSignature>;

const LEGACY_MODEL_KEYS = new Set([
  "id",
  "name",
  "reasoning",
  "input",
  "cost",
  "contextWindow",
  "maxTokens",
]);
const LEGACY_COST_KEYS = new Set(["input", "output", "cacheRead", "cacheWrite"]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeXaiCatalogModelId(modelId: string): string {
  const lower = normalizeOptionalLowercaseString(modelId) ?? "";
  const unprefixed = lower.startsWith("xai/") ? lower.slice("xai/".length) : lower;
  return normalizeXaiModelId(unprefixed);
}

export function isLegacyXaiBuiltinModel(model: unknown): boolean {
  const record = asRecord(model);
  const id = normalizeOptionalLowercaseString(record?.id);
  const signature = id
    ? LEGACY_XAI_BUILTIN_SIGNATURES[id as keyof typeof LEGACY_XAI_BUILTIN_SIGNATURES]
    : undefined;
  const cost = asRecord(record?.cost);
  if (!record || !signature || !cost) {
    return false;
  }
  if (
    Object.keys(record).some((key) => !LEGACY_MODEL_KEYS.has(key)) ||
    Object.keys(cost).some((key) => !LEGACY_COST_KEYS.has(key))
  ) {
    return false;
  }
  const [
    name,
    reasoning,
    input,
    contextWindow,
    maxTokens,
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
  ] = signature;
  return (
    record.name === name &&
    record.reasoning === reasoning &&
    Array.isArray(record.input) &&
    record.input.join(",") === input &&
    record.contextWindow === contextWindow &&
    record.maxTokens === maxTokens &&
    cost.input === inputCost &&
    cost.output === outputCost &&
    cost.cacheRead === cacheReadCost &&
    cost.cacheWrite === cacheWriteCost
  );
}

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
  return XAI_MODEL_CATALOG.filter((entry) => XAI_SELECTABLE_MODEL_IDS.has(entry.id)).map((entry) =>
    toModelDefinition(entry),
  );
}

export function resolveXaiCatalogEntry(modelId: string) {
  const trimmed = modelId.trim();
  const lower = normalizeXaiCatalogModelId(modelId);
  const exact = XAI_MODEL_CATALOG.find(
    (entry) => normalizeOptionalLowercaseString(entry.id) === lower,
  );
  if (exact) {
    return toModelDefinition(exact);
  }
  if (lower === "grok-latest") {
    return toModelDefinition({
      id: trimmed,
      name: trimmed,
      reasoning: true,
      input: ["text", "image"],
      contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
      maxTokens: XAI_DEFAULT_MAX_TOKENS,
      cost: XAI_GROK_43_COST,
    });
  }
  if (lower.includes("multi-agent")) {
    return undefined;
  }
  if (
    lower.startsWith("grok-3-mini-fast") ||
    lower.startsWith("grok-3-mini") ||
    lower.startsWith("grok-3-fast") ||
    lower.startsWith("grok-3")
  ) {
    return toModelDefinition({
      id: trimmed,
      name: trimmed,
      reasoning: lower.includes("mini"),
      input: ["text"],
      contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
      maxTokens: XAI_DEFAULT_MAX_TOKENS,
      cost: XAI_GROK_43_COST,
    });
  }
  if (
    lower.startsWith("grok-4.5") ||
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
      contextWindow: lower.startsWith("grok-4.5")
        ? XAI_GROK_45_CONTEXT_WINDOW
        : XAI_DEFAULT_CONTEXT_WINDOW,
      maxTokens:
        lower.startsWith("grok-4.5") || lower.startsWith("grok-4.3")
          ? XAI_DEFAULT_MAX_TOKENS
          : lower.startsWith("grok-4.20")
            ? 30_000
            : XAI_DEFAULT_MAX_TOKENS,
      cost: lower.startsWith("grok-4.5")
        ? XAI_GROK_45_COST
        : lower.startsWith("grok-4.3")
          ? XAI_GROK_43_COST
          : lower.startsWith("grok-4.20")
            ? XAI_GROK_420_COST
            : XAI_GROK_43_COST,
    });
  }
  if (lower.startsWith("grok-4")) {
    return toModelDefinition({
      id: modelId.trim(),
      name: modelId.trim(),
      reasoning: !lower.includes("non-reasoning"),
      input: ["text"],
      contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
      maxTokens: XAI_DEFAULT_MAX_TOKENS,
      cost: XAI_GROK_43_COST,
    });
  }
  return undefined;
}
