// Data-only primitives shared by runtime models, catalogs, and configuration.
export const MODEL_DATA_APIS = [
  "openai-completions",
  "openai-responses",
  "openai-chatgpt-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-vertex",
  "github-copilot",
  "bedrock-converse-stream",
  "ollama",
  "azure-openai-responses",
] as const;

export const MODEL_DATA_THINKING_FORMATS = [
  "openai",
  "openrouter",
  "deepseek",
  "together",
  "qwen",
  "qwen-chat-template",
  "zai",
] as const;

export type ModelDataThinkingFormat = (typeof MODEL_DATA_THINKING_FORMATS)[number];

export const MODEL_DATA_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ModelDataThinkingLevel = (typeof MODEL_DATA_THINKING_LEVELS)[number];
export type ModelDataThinkingLevelMap = Partial<Record<ModelDataThinkingLevel, string | null>>;

export type ModelDataImageInputConfig = {
  /** Provider-documented maximum encoded image payload size. */
  maxBytes?: number;
  /** Provider-documented maximum accepted input pixels. */
  maxPixels?: number;
  /** Provider-documented maximum accepted width/height in pixels. */
  maxSidePx?: number;
  /** Preferred resize side for the default balanced compression policy. */
  preferredSidePx?: number;
  /** Token accounting style, used as documentation for provider-owned policy. */
  tokenMode?: "tile" | "detail" | "provider";
};

export type ModelDataMediaInputConfig = {
  /** Image input limits and accounting hints for this model. */
  image?: ModelDataImageInputConfig;
};

/** Per-million-token rates for separately billed token buckets. */
export type ModelDataCostRates = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type ModelDataRawPricingTier = ModelDataCostRates & {
  /** Half-open prompt-token interval; `[start]` is an open-ended upper tier. */
  range: [number, number] | [number];
};

export type ModelRoutingSortConfig = {
  /** The sorting metric: "price", "throughput", "latency". */
  by?: string;
  /** Partitioning strategy: "model" (default) or "none". */
  partition?: string | null;
};

export type ModelRoutingMaxPrice = {
  /** Price per million prompt tokens. */
  prompt?: number | string;
  /** Price per million completion tokens. */
  completion?: number | string;
  /** Price per image. */
  image?: number | string;
  /** Price per audio unit. */
  audio?: number | string;
  /** Price per request. */
  request?: number | string;
};

/** Percentile targets in the owning field's throughput or latency units. */
export type ModelRoutingPercentiles = {
  p50?: number;
  p75?: number;
  p90?: number;
  p99?: number;
};
