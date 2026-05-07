import { normalizeLowercaseStringOrEmpty } from "./string-coerce.ts";
import { normalizeThinkLevel } from "./thinking.ts";

export function normalizeThinkingOptionValue(raw: string): string {
  return normalizeThinkLevel(raw) ?? normalizeLowercaseStringOrEmpty(raw);
}

export function formatInheritedThinkingLabel(effectiveLevel: string | null | undefined): string {
  const normalized = effectiveLevel ? normalizeThinkingOptionValue(effectiveLevel) : "off";
  if (!normalized || normalized === "off") {
    return "Off";
  }
  return `Inherited: ${normalized}`;
}

export function formatThinkingOverrideLabel(value: string, label?: string | null): string {
  const normalized = normalizeThinkingOptionValue(value);
  if (!normalized || normalized === "off") {
    return "Off";
  }
  const displayLabel = label?.trim() || normalized;
  return `Override: ${displayLabel}`;
}
