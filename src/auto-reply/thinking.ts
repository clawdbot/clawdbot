export type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type VerboseLevel = "off" | "on" | "full";
export type ElevatedLevel = "off" | "on" | "ask" | "full";
export type ElevatedMode = "off" | "ask" | "full";
export type ReasoningLevel = "off" | "on" | "stream";
export type UsageDisplayLevel = "off" | "tokens" | "full";

function normalizeProviderId(provider?: string | null): string {
  if (!provider) return "";
  const normalized = provider.trim().toLowerCase();
  if (normalized === "z.ai" || normalized === "z-ai") return "zai";
  return normalized;
}

export function isBinaryThinkingProvider(provider?: string | null): boolean {
  return normalizeProviderId(provider) === "zai";
}

export const XHIGH_MODEL_REFS = [
  "openai/gpt-5.2",
  "openai-codex/gpt-5.2-codex",
  "openai-codex/gpt-5.1-codex",
] as const;

const XHIGH_MODEL_SET = new Set(XHIGH_MODEL_REFS.map((entry) => entry.toLowerCase()));
const XHIGH_MODEL_IDS = new Set(
  XHIGH_MODEL_REFS.map((entry) => entry.split("/")[1]?.toLowerCase()).filter(
    (entry): entry is string => Boolean(entry),
  ),
);

// Normalize user-provided thinking level strings to the canonical enum.
export function normalizeThinkLevel(raw?: string | null): ThinkLevel | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (["off"].includes(key)) return "off";
  if (["on", "enable", "enabled"].includes(key)) return "low";
  if (["min", "minimal"].includes(key)) return "minimal";
  if (["low", "thinkhard", "think-hard", "think_hard"].includes(key)) return "low";
  if (["mid", "med", "medium", "thinkharder", "think-harder", "harder"].includes(key))
    return "medium";
  if (["high", "ultra", "ultrathink", "think-hard", "thinkhardest", "highest", "max"].includes(key))
    return "high";
  if (["xhigh", "x-high", "x_high"].includes(key)) return "xhigh";
  if (["think"].includes(key)) return "minimal";
  return undefined;
}

export function supportsXHighThinking(provider?: string | null, model?: string | null): boolean {
  const modelKey = model?.trim().toLowerCase();
  if (!modelKey) return false;
  const providerKey = provider?.trim().toLowerCase();
  if (providerKey) {
    return XHIGH_MODEL_SET.has(`${providerKey}/${modelKey}`);
  }
  return XHIGH_MODEL_IDS.has(modelKey);
}

export function listThinkingLevels(provider?: string | null, model?: string | null): ThinkLevel[] {
  const levels: ThinkLevel[] = ["off", "minimal", "low", "medium", "high"];
  if (supportsXHighThinking(provider, model)) levels.push("xhigh");
  return levels;
}

export function listThinkingLevelLabels(provider?: string | null, model?: string | null): string[] {
  if (isBinaryThinkingProvider(provider)) return ["off", "on"];
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
  const refs = [...XHIGH_MODEL_REFS] as string[];
  if (refs.length === 0) return "unknown model";
  if (refs.length === 1) return refs[0];
  if (refs.length === 2) return `${refs[0]} or ${refs[1]}`;
  return `${refs.slice(0, -1).join(", ")} or ${refs[refs.length - 1]}`;
}

// Normalize verbose flags used to toggle agent verbosity.
export function normalizeVerboseLevel(raw?: string | null): VerboseLevel | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (["off", "false", "no", "0"].includes(key)) return "off";
  if (["full", "all", "everything"].includes(key)) return "full";
  if (["on", "minimal", "true", "yes", "1"].includes(key)) return "on";
  return undefined;
}

// Normalize response-usage display modes used to toggle per-response usage footers.
export function normalizeUsageDisplay(raw?: string | null): UsageDisplayLevel | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (["off", "false", "no", "0", "disable", "disabled"].includes(key)) return "off";
  if (["on", "true", "yes", "1", "enable", "enabled"].includes(key)) return "tokens";
  if (["tokens", "token", "tok", "minimal", "min"].includes(key)) return "tokens";
  if (["full", "session"].includes(key)) return "full";
  return undefined;
}

export function resolveResponseUsageMode(raw?: string | null): UsageDisplayLevel {
  return normalizeUsageDisplay(raw) ?? "off";
}

// Normalize elevated flags used to toggle elevated bash permissions.
export function normalizeElevatedLevel(raw?: string | null): ElevatedLevel | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (["off", "false", "no", "0"].includes(key)) return "off";
  if (["full", "auto", "auto-approve", "autoapprove"].includes(key)) return "full";
  if (["ask", "prompt", "approval", "approve"].includes(key)) return "ask";
  if (["on", "true", "yes", "1"].includes(key)) return "on";
  return undefined;
}

export function resolveElevatedMode(level?: ElevatedLevel | null): ElevatedMode {
  if (!level || level === "off") return "off";
  if (level === "full") return "full";
  return "ask";
}

// Normalize reasoning visibility flags used to toggle reasoning exposure.
export function normalizeReasoningLevel(raw?: string | null): ReasoningLevel | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (["off", "false", "no", "0", "hide", "hidden", "disable", "disabled"].includes(key))
    return "off";
  if (["on", "true", "yes", "1", "show", "visible", "enable", "enabled"].includes(key)) return "on";
  if (["stream", "streaming", "draft", "live"].includes(key)) return "stream";
  return undefined;
}
