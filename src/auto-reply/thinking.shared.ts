import {
  normalizeFastMode,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";

export { normalizeFastMode };

export type ThinkLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive"
  | "max";
export type VerboseLevel = "off" | "on" | "full";
export type TraceLevel = "off" | "on" | "raw";
export type NoticeLevel = "off" | "on" | "full";
export type ElevatedLevel = "off" | "on" | "ask" | "full";
export type ElevatedMode = "off" | "ask" | "full";
export type ReasoningLevel = "off" | "on" | "stream";
export type UsageDisplayLevel = "off" | "tokens" | "full";
export type ThinkingCatalogEntry = {
  provider: string;
  id: string;
  reasoning?: boolean;
  compat?: {
    supportedReasoningEfforts?: readonly string[] | null;
  } | null;
};

export const BASE_THINKING_LEVELS: ThinkLevel[] = ["off", "minimal", "low", "medium", "high"];
export const THINKING_LEVEL_RANKS: Record<ThinkLevel, number> = {
  off: 0,
  minimal: 10,
  low: 20,
  medium: 30,
  high: 40,
  adaptive: 30,
  xhigh: 60,
  max: 70,
};
const NO_THINKING_LEVELS: ThinkLevel[] = [...BASE_THINKING_LEVELS];

export function isBinaryThinkingProvider(provider?: string | null): boolean {
  void provider;
  return false;
}

// Normalize user-provided thinking level strings to the canonical enum.
export function normalizeThinkLevel(raw?: string | null): ThinkLevel | undefined {
  const key = normalizeOptionalLowercaseString(raw);
  if (!key) {
    return undefined;
  }
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
  if (["off"].includes(key)) {
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
  if (["think"].includes(key)) {
    return "minimal";
  }
  return undefined;
}

export function listThinkingLevels(
  _provider?: string | null,
  _model?: string | null,
): ThinkLevel[] {
  return [...NO_THINKING_LEVELS];
}

export function listThinkingLevelLabels(provider?: string | null, model?: string | null): string[] {
  if (isBinaryThinkingProvider(provider)) {
    return ["off", "on"];
  }
  return listThinkingLevels(provider, model);
}

export function formatThinkingLevels(
  provider?: string | null,
  model?: string | null,
  separator = ", ",
): string {
  return listThinkingLevelLabels(provider, model).join(separator);
}

export function formatXHighModelHint(): string {
  return "provider models that advertise xhigh reasoning";
}

export function resolveThinkingDefaultForModel(params: {
  provider: string;
  model: string;
  catalog?: ThinkingCatalogEntry[];
}): ThinkLevel {
  const candidate = params.catalog?.find(
    (entry) => entry.provider === params.provider && entry.id === params.model,
  );
  if (candidate?.reasoning) {
    return "low";
  }
  return "off";
}

type OnOffFullLevel = "off" | "on" | "full";

function normalizeOnOffFullLevel(raw?: string | null): OnOffFullLevel | undefined {
  const key = normalizeOptionalLowercaseString(raw);
  if (!key) {
    return undefined;
  }
  if (["off", "false", "no", "0"].includes(key)) {
    return "off";
  }
  if (["full", "all", "everything"].includes(key)) {
    return "full";
  }
  if (["on", "minimal", "true", "yes", "1"].includes(key)) {
    return "on";
  }
  return undefined;
}

export function normalizeVerboseLevel(raw?: string | null): VerboseLevel | undefined {
  return normalizeOnOffFullLevel(raw);
}

export function normalizeTraceLevel(raw?: string | null): TraceLevel | undefined {
  const key = normalizeOptionalLowercaseString(raw);
  if (!key) {
    return undefined;
  }
  if (["off", "false", "no", "0"].includes(key)) {
    return "off";
  }
  if (["on", "true", "yes", "1"].includes(key)) {
    return "on";
  }
  if (["raw", "unfiltered"].includes(key)) {
    return "raw";
  }
  return undefined;
}

export function normalizeNoticeLevel(raw?: string | null): NoticeLevel | undefined {
  return normalizeOnOffFullLevel(raw);
}

export function normalizeUsageDisplay(raw?: string | null): UsageDisplayLevel | undefined {
  if (!raw) {
    return undefined;
  }
  const key = normalizeLowercaseStringOrEmpty(raw);
  if (["off", "false", "no", "0", "disable", "disabled"].includes(key)) {
    return "off";
  }
  if (["on", "true", "yes", "1", "enable", "enabled"].includes(key)) {
    return "tokens";
  }
  if (["tokens", "token", "tok", "minimal", "min"].includes(key)) {
    return "tokens";
  }
  if (["full", "session"].includes(key)) {
    return "full";
  }
  return undefined;
}

export function resolveResponseUsageMode(raw?: string | null): UsageDisplayLevel {
  return normalizeUsageDisplay(raw) ?? "off";
}

export function normalizeElevatedLevel(raw?: string | null): ElevatedLevel | undefined {
  if (!raw) {
    return undefined;
  }
  const key = normalizeLowercaseStringOrEmpty(raw);
  if (["off", "false", "no", "0"].includes(key)) {
    return "off";
  }
  if (["full", "auto", "auto-approve", "autoapprove"].includes(key)) {
    return "full";
  }
  if (["ask", "prompt", "approval", "approve"].includes(key)) {
    return "ask";
  }
  if (["on", "true", "yes", "1"].includes(key)) {
    return "on";
  }
  return undefined;
}

export function resolveElevatedMode(level?: ElevatedLevel | null): ElevatedMode {
  if (!level || level === "off") {
    return "off";
  }
  if (level === "full") {
    return "full";
  }
  return "ask";
}

export function normalizeReasoningLevel(raw?: string | null): ReasoningLevel | undefined {
  if (!raw) {
    return undefined;
  }
  const key = normalizeLowercaseStringOrEmpty(raw);
  if (["off", "false", "no", "0", "hide", "hidden", "disable", "disabled"].includes(key)) {
    return "off";
  }
  if (["on", "true", "yes", "1", "show", "visible", "enable", "enabled"].includes(key)) {
    return "on";
  }
  if (["stream", "streaming", "draft", "live"].includes(key)) {
    return "stream";
  }
  return undefined;
}
