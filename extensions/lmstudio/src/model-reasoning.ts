import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const LMSTUDIO_OPENAI_COMPAT_ENABLED_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export const LMSTUDIO_OPENAI_COMPAT_REASONING_EFFORTS = [
  "none",
  ...LMSTUDIO_OPENAI_COMPAT_ENABLED_REASONING_EFFORTS,
] as const;

function resolveLmstudioEnabledTransportReasoningOption(
  supportedReasoningEfforts: readonly string[],
): string | undefined {
  return (
    supportedReasoningEfforts.find((option) => option === "xhigh") ??
    supportedReasoningEfforts.find((option) => option === "high") ??
    supportedReasoningEfforts.find((option) => option !== "none")
  );
}

export function buildLmstudioReasoningEffortMap(
  supportedReasoningEfforts: readonly string[],
): Record<string, string> | undefined {
  const disabled = supportedReasoningEfforts.includes("none") ? "none" : undefined;
  const max = resolveLmstudioEnabledTransportReasoningOption(supportedReasoningEfforts);
  const map = {
    ...(disabled ? { off: disabled, none: disabled } : {}),
    ...(max ? { adaptive: max, max } : {}),
  };
  return Object.keys(map).length > 0 ? map : undefined;
}

export function normalizeLmstudioTransportReasoningCompat(
  compat: NonNullable<ModelDefinitionConfig["compat"]>,
): NonNullable<ModelDefinitionConfig["compat"]> {
  const supportedReasoningEfforts = compat.supportedReasoningEfforts;
  const map = compat.reasoningEffortMap;
  const hasBinarySupported =
    Array.isArray(supportedReasoningEfforts) &&
    supportedReasoningEfforts.some((option) => option === "on");
  const hasBinaryMapValue =
    map !== undefined && Object.values(map).some((value) => value === "on" || value === "off");
  if (!hasBinarySupported && !hasBinaryMapValue) {
    return compat;
  }
  const hasDisabled =
    supportedReasoningEfforts?.includes("off") === true ||
    supportedReasoningEfforts?.includes("none") === true ||
    Object.values(map ?? {}).some((value) => value === "off" || value === "none");
  const normalizedSupportedReasoningEfforts = hasDisabled
    ? [...LMSTUDIO_OPENAI_COMPAT_REASONING_EFFORTS]
    : [...LMSTUDIO_OPENAI_COMPAT_ENABLED_REASONING_EFFORTS];
  return {
    ...compat,
    supportedReasoningEfforts: normalizedSupportedReasoningEfforts,
    reasoningEffortMap: buildLmstudioReasoningEffortMap(normalizedSupportedReasoningEfforts),
  };
}
