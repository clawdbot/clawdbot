import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { summarizeToolDescriptionText } from "./tool-description-summary.js";
import { resolveToolDisplay } from "./tool-display.js";
import type { EffectiveToolInventoryEntry } from "./tools-effective-inventory.types.js";
import type { AnyAgentTool } from "./tools/common.js";

export function resolveEffectiveToolLabel(tool: AnyAgentTool): string {
  const rawLabel = normalizeOptionalString(tool.label) ?? "";
  if (
    rawLabel &&
    normalizeLowercaseStringOrEmpty(rawLabel) !== normalizeLowercaseStringOrEmpty(tool.name)
  ) {
    return rawLabel;
  }
  return resolveToolDisplay({ name: tool.name }).title;
}

export function resolveEffectiveToolRawDescription(tool: AnyAgentTool): string {
  return normalizeOptionalString(tool.description) ?? "";
}

export function summarizeEffectiveToolDescription(tool: AnyAgentTool): string {
  return summarizeToolDescriptionText({
    rawDescription: resolveEffectiveToolRawDescription(tool),
    displaySummary: tool.displaySummary,
  });
}

export function disambiguateEffectiveToolLabels(
  entries: EffectiveToolInventoryEntry[],
  resolveSuffix: (entry: EffectiveToolInventoryEntry) => string,
): EffectiveToolInventoryEntry[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);
  }
  return entries.map((entry) => {
    if ((counts.get(entry.label) ?? 0) < 2) {
      return entry;
    }
    return { ...entry, label: `${entry.label} (${resolveSuffix(entry)})` };
  });
}
