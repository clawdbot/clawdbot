// Xai plugin module implements model definitions behavior.
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  asOptionalRecord,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeXaiModelId } from "./model-id.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export const XAI_BASE_URL = manifest.modelCatalog.providers.xai.baseUrl;
export const XAI_DEFAULT_IMAGE_MODEL = "grok-imagine-image";
export const XAI_IMAGE_MODELS = ["grok-imagine-image", "grok-imagine-image-quality"] as const;
export const XAI_DEFAULT_CONTEXT_WINDOW = 1_000_000;
export const XAI_DEFAULT_MAX_TOKENS = 64_000;
export const XAI_DEFAULT_MODEL_ID = "grok-4.6";
/** Models outside the manifest carry no price until the manifest lists them. */
export const XAI_UNKNOWN_MODEL_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} satisfies ModelDefinitionConfig["cost"];

type XaiModelInput = ModelDefinitionConfig["input"][number];

function isXaiModelInput(value: string): value is XaiModelInput {
  return value === "text" || value === "image" || value === "video" || value === "audio";
}

function toXaiModelDefinition(model: (typeof manifest.modelCatalog.providers.xai.models)[number]) {
  return { ...model, input: model.input.filter(isXaiModelInput) } satisfies ModelDefinitionConfig;
}

function copyXaiModelDefinition(entry: ModelDefinitionConfig): ModelDefinitionConfig {
  return { ...entry, input: [...entry.input] };
}

// The manifest is the one curated xAI model list; discovery only adds or prunes around it.
const XAI_MODEL_CATALOG: readonly ModelDefinitionConfig[] =
  manifest.modelCatalog.providers.xai.models.map(toXaiModelDefinition);

/** Exact curated row for a model id, after xAI alias normalization. */
export function resolveXaiCatalogEntry(modelId: string): ModelDefinitionConfig | undefined {
  const normalized = normalizeXaiCatalogModelId(modelId);
  const entry = XAI_MODEL_CATALOG.find((model) => model.id.toLowerCase() === normalized);
  return entry ? copyXaiModelDefinition(entry) : undefined;
}

export function buildXaiModelDefinition(): ModelDefinitionConfig {
  const entry = resolveXaiCatalogEntry(XAI_DEFAULT_MODEL_ID);
  if (!entry) {
    throw new Error(`xai manifest omits the default model ${XAI_DEFAULT_MODEL_ID}`);
  }
  return entry;
}

export function buildXaiCatalogModels(): ModelDefinitionConfig[] {
  return XAI_MODEL_CATALOG.map(copyXaiModelDefinition);
}

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

function normalizeXaiCatalogModelId(modelId: string): string {
  const lower = normalizeOptionalLowercaseString(modelId) ?? "";
  const unprefixed = lower.startsWith("xai/") ? lower.slice("xai/".length) : lower;
  return normalizeXaiModelId(unprefixed);
}

export function isLegacyXaiBuiltinModel(model: unknown): boolean {
  const record = asOptionalRecord(model);
  const id = normalizeOptionalLowercaseString(record?.id);
  const signature = id
    ? LEGACY_XAI_BUILTIN_SIGNATURES[id as keyof typeof LEGACY_XAI_BUILTIN_SIGNATURES]
    : undefined;
  const cost = asOptionalRecord(record?.cost);
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
