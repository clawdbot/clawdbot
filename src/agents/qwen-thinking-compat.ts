/**
 * Infer reasoning + thinkingFormat for Qwen 3.5+ custom openai-completions rows
 * when the operator omitted those fields.
 */
import type { ModelCompatConfig } from "../config/types.models.js";
import { normalizeProviderId } from "./model-ref-shared.js";

export type QwenThinkingFormat = "qwen" | "qwen-chat-template";

/**
 * Qwen 3.5+ thinking family ids (plus/flash/max and local weights like
 * qwen3.6-27b). Older plain qwen3-8b rows stay opt-in via explicit config.
 */
export function isQwenThinkingCapableModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const leaf = normalized.includes("/")
    ? normalized.slice(normalized.lastIndexOf("/") + 1)
    : normalized;
  // qwen3.5+ / qwen3.6-27b / qwen3-6-27b. Dash form only accepts minor 5–7 so
  // size tags like qwen3-8b stay opt-in.
  return /^qwen3(?:\.[5-9]|[-_][5-7](?:\D|$))/.test(leaf);
}

export function resolveQwenThinkingFormatForRoute(params: {
  provider: string;
  baseUrl?: string | null;
}): QwenThinkingFormat {
  const providerId = normalizeProviderId(params.provider);
  if (
    providerId === "vllm" ||
    providerId === "lmstudio" ||
    providerId === "ollama" ||
    providerId === "sglang"
  ) {
    return "qwen-chat-template";
  }
  const baseUrl = typeof params.baseUrl === "string" ? params.baseUrl.trim().toLowerCase() : "";
  if (
    baseUrl.includes("localhost") ||
    baseUrl.includes("127.0.0.1") ||
    baseUrl.includes("[::1]") ||
    baseUrl.includes("0.0.0.0")
  ) {
    return "qwen-chat-template";
  }
  return "qwen";
}

function mergeCompat(
  base: ModelCompatConfig | undefined,
  override: ModelCompatConfig | undefined,
): ModelCompatConfig | undefined {
  if (!base) {
    return override;
  }
  if (!override) {
    return base;
  }
  return { ...base, ...override };
}

/** Fill omitted reasoning / thinkingFormat for Qwen3.5+ custom openai-completions rows. */
export function applyInferredQwenThinkingCompat(params: {
  provider: string;
  modelId: string;
  baseUrl?: string | null;
  reasoning?: boolean;
  compat?: ModelCompatConfig;
}): { reasoning?: boolean; compat?: ModelCompatConfig } {
  if (!isQwenThinkingCapableModelId(params.modelId)) {
    return {
      ...(params.reasoning !== undefined ? { reasoning: params.reasoning } : {}),
      ...(params.compat ? { compat: params.compat } : {}),
    };
  }
  const reasoning = params.reasoning ?? true;
  const existingFormat = params.compat?.thinkingFormat;
  if (existingFormat) {
    return {
      reasoning,
      ...(params.compat ? { compat: params.compat } : {}),
    };
  }
  const thinkingFormat = resolveQwenThinkingFormatForRoute({
    provider: params.provider,
    baseUrl: params.baseUrl,
  });
  return {
    reasoning,
    compat: mergeCompat(params.compat, { thinkingFormat }),
  };
}
