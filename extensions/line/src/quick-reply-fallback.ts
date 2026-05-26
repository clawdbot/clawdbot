import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";

export function buildLineQuickReplyFallbackText(labels: readonly string[] | undefined): string {
  const normalized = normalizeStringEntries(labels ?? []).slice(0, 13);
  if (normalized.length === 0) {
    return "Choose an option.";
  }
  return `Options:\n${normalized.map((label) => `- ${label}`).join("\n")}`;
}
