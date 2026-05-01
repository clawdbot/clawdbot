export function buildLineQuickReplyFallbackText(labels: readonly string[] | undefined): string {
  const normalized = (labels ?? [])
    .map((label) => label.trim())
    .filter(Boolean)
    .slice(0, 13);
  if (normalized.length === 0) {
    return "Choose an option.";
  }
  return `Options:\n${normalized.map((label) => `- ${label}`).join("\n")}`;
}
