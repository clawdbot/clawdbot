import { normalizeLowercaseStringOrEmpty } from "./string-coerce.ts";

export type ThinkingCatalogEntry = {
  provider: string;
  id: string;
  reasoning?: boolean;
};

const BASE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;

export function normalizeThinkingProviderId(provider?: string | null): string {
  if (!provider) {
    return "";
  }
  const normalized = normalizeLowercaseStringOrEmpty(provider);
  if (normalized === "z.ai" || normalized === "z-ai") {
    return "zai";
  }
  if (normalized === "bedrock" || normalized === "aws-bedrock") {
    return "amazon-bedrock";
  }
  return normalized;
}

export function isBinaryThinkingProvider(provider?: string | null): boolean {
  void provider;
  return false;
}

export function normalizeThinkLevel(raw?: string | null): string | undefined {
  if (!raw) {
    return undefined;
  }
  const key = normalizeLowercaseStringOrEmpty(raw);
  const collapsed = key.replace(/[\s_-]+/g, "");
  if (collapsed === "adaptive" || collapsed === "auto") {
    return "adaptive";
  }
  if (collapsed === "max") {
    return "max";
  }
  if (collapsed === "xhigh" || collapsed === "extrahigh") {
    return "xhigh";
  }
  if (key === "off") {
    return "off";
  }
  if (["on", "enable", "enabled"].includes(key)) {
    return "low";
  }
  if (["min", "minimal"].includes(key)) {
    return "minimal";
  }
  if (["low", "thinkhard", "think-hard", "think_hard"].includes(key)) {
    return "low";
  }
  if (["mid", "med", "medium", "thinkharder", "think-harder", "harder"].includes(key)) {
    return "medium";
  }
  if (["high", "ultra", "ultrathink", "think-hard", "thinkhardest", "highest"].includes(key)) {
    return "high";
  }
  if (key === "think") {
    return "minimal";
  }
  return undefined;
}

export function listThinkingLevelLabels(
  provider?: string | null,
  model?: string | null,
): readonly string[] {
  void provider;
  void model;
  return BASE_THINKING_LEVELS;
}

export function formatThinkingLevels(provider?: string | null, model?: string | null): string {
  return listThinkingLevelLabels(provider, model).join(", ");
}

export function resolveThinkingDefaultForModel(params: {
  provider: string;
  model: string;
  catalog?: ThinkingCatalogEntry[];
}): string {
  const candidate = params.catalog?.find(
    (entry) => entry.provider === params.provider && entry.id === params.model,
  );
  return candidate?.reasoning ? "low" : "off";
}
