/** Shared normalization for thinking, verbosity, tracing, reasoning, and usage directives. */
import {
  type FastMode,
  normalizeFastMode,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../../packages/normalization-core/src/string-coerce.js";

export { normalizeFastMode };
export type { FastMode };

/** Canonical thinking level values accepted by chat commands and session state. */
export type ThinkLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive"
  | "max"
  | "ultra";
export type VerboseLevel = "off" | "on" | "full";
export type TraceLevel = "off" | "on" | "raw";
export type ElevatedLevel = "off" | "on" | "ask" | "full";
export type ReasoningLevel = "off" | "on" | "stream";
type UsageDisplayLevel = "off" | "tokens" | "full";
/** Minimal model catalog entry needed to choose thinking defaults. */
export type ThinkingCatalogEntry = {
  provider: string;
  id: string;
  api?: string;
  reasoning?: boolean;
  params?: Record<string, unknown>;
  compat?: {
    thinkingFormat?: string;
    supportedReasoningEfforts?: readonly string[] | null;
  } | null;
};

/** Complete canonical level set accepted by user-facing thinking controls. */
const ALL_THINKING_LEVELS: readonly ThinkLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "adaptive",
  "max",
  "ultra",
];
export const THINKING_LEVELS_HELP = ALL_THINKING_LEVELS.join("|");
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
  ultra: 80,
};

/** Normalizes user-provided thinking level strings to the canonical enum. */
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
  if (collapsed === "ultra") {
    return "ultra";
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
  if (["high", "ultrathink", "think-hard", "thinkhardest", "highest"].includes(key)) {
    return "high";
  }
  if (["think"].includes(key)) {
    return "minimal";
  }
  return undefined;
}

/** Returns true for command values that clear an inherited session override. */
export function isSessionDefaultDirectiveValue(raw?: string | null): boolean {
  const key = normalizeOptionalLowercaseString(raw);
  if (!key) {
    return false;
  }
  return ["default", "inherit", "inherited", "clear", "reset", "unpin"].includes(key);
}

/** Chooses the default thinking level for one provider/model catalog entry. */
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

/** Normalizes /verbose values. */
export function normalizeVerboseLevel(raw?: string | null): VerboseLevel | undefined {
  return normalizeOnOffFullLevel(raw);
}

/** Normalizes /trace values. */
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

/** Normalizes response usage display values. */
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

/** Resolves response usage display mode with the persisted default. */
export function resolveResponseUsageMode(raw?: string | null): UsageDisplayLevel {
  return normalizeUsageDisplay(raw) ?? "off";
}

type ResponseUsageInput = "on" | "off" | "tokens" | "full";
type ResponseUsageDefaultConfig =
  | ResponseUsageInput
  | { default?: ResponseUsageInput; [channel: string]: ResponseUsageInput | undefined };

function resolveMessagesResponseUsageDefault(
  configured: ResponseUsageDefaultConfig | undefined,
  channel?: string,
): ResponseUsageInput | undefined {
  if (typeof configured === "string") {
    return configured;
  }
  if (configured && typeof configured === "object") {
    return (channel ? configured[channel] : undefined) ?? configured.default;
  }
  return undefined;
}

export function resolveEffectiveResponseUsage(
  sessionRaw: string | undefined | null,
  configured: ResponseUsageDefaultConfig | undefined,
  channel?: string,
): UsageDisplayLevel {
  const sessionNormalized = normalizeUsageDisplay(sessionRaw);
  if (sessionNormalized !== undefined) {
    return sessionNormalized;
  }
  const configDefault = resolveMessagesResponseUsageDefault(configured, channel);
  return resolveResponseUsageMode(configDefault);
}

/** Normalizes elevated execution policy values. */
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

/** Normalizes reasoning visibility values. */
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
