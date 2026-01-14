export type ThinkLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
export type VerboseLevel = "off" | "on";
export type ElevatedLevel = "off" | "on";
export type ReasoningLevel = "off" | "on" | "stream";
export type UsageDisplayLevel = "off" | "on";

export const XHIGH_MODEL_REFS = [
  "openai/gpt-5.2",
  "openai-codex/gpt-5.2-codex",
  "openai-codex/gpt-5.1-codex",
] as const;

const XHIGH_MODEL_SET = new Set(
  XHIGH_MODEL_REFS.map((entry) => entry.toLowerCase()),
);
const XHIGH_MODEL_IDS = new Set(
  XHIGH_MODEL_REFS.map((entry) => entry.split("/")[1]?.toLowerCase()).filter(
    (entry): entry is string => Boolean(entry),
  ),
);

// Normalize user-provided thinking level strings to the canonical enum.
export function normalizeThinkLevel(
  raw?: string | null,
): ThinkLevel | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (["off"].includes(key)) return "off";
  if (["min", "minimal"].includes(key)) return "minimal";
  if (["low", "thinkhard", "think-hard", "think_hard"].includes(key))
    return "low";
  if (
    ["mid", "med", "medium", "thinkharder", "think-harder", "harder"].includes(
      key,
    )
  )
    return "medium";
  if (
    [
      "high",
      "ultra",
      "ultrathink",
      "think-hard",
      "thinkhardest",
      "highest",
      "max",
    ].includes(key)
  )
    return "high";
  if (["xhigh", "x-high", "x_high"].includes(key)) return "xhigh";
  if (["think"].includes(key)) return "minimal";
  return undefined;
}

export function supportsXHighThinking(
  provider?: string | null,
  model?: string | null,
): boolean {
  const modelKey = model?.trim().toLowerCase();
  if (!modelKey) return false;
  const providerKey = provider?.trim().toLowerCase();
  if (providerKey) {
    return XHIGH_MODEL_SET.has(`${providerKey}/${modelKey}`);
  }
  return XHIGH_MODEL_IDS.has(modelKey);
}

export function listThinkingLevels(
  provider?: string | null,
  model?: string | null,
): ThinkLevel[] {
  const levels: ThinkLevel[] = ["off", "minimal", "low", "medium", "high"];
  if (supportsXHighThinking(provider, model)) levels.push("xhigh");
  return levels;
}

export function formatThinkingLevels(
  provider?: string | null,
  model?: string | null,
  separator = ", ",
): string {
  return listThinkingLevels(provider, model).join(separator);
}

export function formatXHighModelHint(): string {
  const refs = [...XHIGH_MODEL_REFS] as string[];
  if (refs.length === 0) return "unknown model";
  if (refs.length === 1) return refs[0];
  if (refs.length === 2) return `${refs[0]} or ${refs[1]}`;
  return `${refs.slice(0, -1).join(", ")} or ${refs[refs.length - 1]}`;
}

// Normalize verbose flags used to toggle agent verbosity.
export function normalizeVerboseLevel(
  raw?: string | null,
): VerboseLevel | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (["off", "false", "no", "0"].includes(key)) return "off";
  if (["on", "full", "true", "yes", "1"].includes(key)) return "on";
  return undefined;
}

// Normalize response-usage display flags used to toggle cost/token lines.
export function normalizeUsageDisplay(
  raw?: string | null,
): UsageDisplayLevel | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (["off", "false", "no", "0", "disable", "disabled"].includes(key))
    return "off";
  if (["on", "true", "yes", "1", "enable", "enabled"].includes(key))
    return "on";
  return undefined;
}

// Normalize elevated flags used to toggle elevated bash permissions.
export function normalizeElevatedLevel(
  raw?: string | null,
): ElevatedLevel | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (["off", "false", "no", "0"].includes(key)) return "off";
  if (["on", "true", "yes", "1"].includes(key)) return "on";
  return undefined;
}

// Normalize reasoning visibility flags used to toggle reasoning exposure.
export function normalizeReasoningLevel(
  raw?: string | null,
): ReasoningLevel | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (
    [
      "off",
      "false",
      "no",
      "0",
      "hide",
      "hidden",
      "disable",
      "disabled",
    ].includes(key)
  )
    return "off";
  if (
    ["on", "true", "yes", "1", "show", "visible", "enable", "enabled"].includes(
      key,
    )
  )
    return "on";
  if (["stream", "streaming", "draft", "live"].includes(key)) return "stream";
  return undefined;
}
