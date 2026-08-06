export function normalizeOptionalChatText(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function normalizeUnknownChatText(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeOptionalChatText(value) : undefined;
}
