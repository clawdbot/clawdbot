import type { ModelCompatConfig, ModelMediaInputConfig } from "../../config/types.models.js";
import { normalizeProviderId } from "../model-selection.js";
import { isQwenThinkingCapableModelId } from "../qwen-thinking-compat.js";

export {
  applyInferredQwenThinkingCompat,
  isQwenThinkingCapableModelId,
  resolveQwenThinkingFormatForRoute,
} from "../qwen-thinking-compat.js";

export function mergeModelMediaInput(
  base: ModelMediaInputConfig | undefined,
  override: ModelMediaInputConfig | undefined,
): ModelMediaInputConfig | undefined {
  if (!base) {
    return override;
  }
  if (!override) {
    return base;
  }
  return {
    ...base,
    ...override,
    image:
      base.image || override.image
        ? {
            ...base.image,
            ...override.image,
          }
        : undefined,
  };
}

export function resolveConfiguredFallbackReasoning(params: {
  provider: string;
  modelId?: string;
  compat?: unknown;
  reasoning?: boolean;
}): boolean {
  return resolveConfiguredModelReasoning(params) ?? false;
}

export function resolveConfiguredModelReasoning(params: {
  provider: string;
  modelId?: string;
  compat?: unknown;
  reasoning?: boolean;
}): boolean | undefined {
  if (params.reasoning !== undefined) {
    return params.reasoning;
  }
  if (isVllmQwenThinkingCompat(params)) {
    return true;
  }
  return params.modelId && isQwenThinkingCapableModelId(params.modelId) ? true : undefined;
}

export function resolveMergedConfiguredModelReasoning(params: {
  provider: string;
  modelId?: string;
  configuredCompat?: unknown;
  resolvedCompat?: unknown;
  configuredReasoning?: boolean;
  discoveredReasoning?: boolean;
}): boolean {
  if (params.configuredReasoning !== undefined) {
    return params.configuredReasoning;
  }
  if (isVllmQwenThinkingCompat({ provider: params.provider, compat: params.configuredCompat })) {
    return true;
  }
  if (params.modelId && isQwenThinkingCapableModelId(params.modelId)) {
    return true;
  }
  return (
    resolveConfiguredModelReasoning({
      provider: params.provider,
      modelId: params.modelId,
      compat: params.resolvedCompat,
      reasoning: params.discoveredReasoning,
    }) ?? false
  );
}

function isVllmQwenThinkingCompat(params: { provider: string; compat?: unknown }): boolean {
  const thinkingFormat = readCompatThinkingFormat(params.compat);
  return (
    normalizeProviderId(params.provider) === "vllm" &&
    (thinkingFormat === "qwen" || thinkingFormat === "qwen-chat-template")
  );
}

function readCompatThinkingFormat(compat: unknown): string | undefined {
  if (!compat || typeof compat !== "object" || Array.isArray(compat)) {
    return undefined;
  }
  const thinkingFormat = (compat as { thinkingFormat?: unknown }).thinkingFormat;
  return typeof thinkingFormat === "string" ? thinkingFormat : undefined;
}

export function mergeModelCompat(
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
