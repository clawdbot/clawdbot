export function extractModelDirective(body?: string): {
  cleaned: string;
  rawModel?: string;
  rawProfile?: string;
  hasDirective: boolean;
} {
  if (!body) return { cleaned: "", hasDirective: false };
  const match = body.match(
    /(?:^|\s)\/model(?=$|\s|:)\s*:?\s*([A-Za-z0-9_.:@-]+(?:\/[A-Za-z0-9_.:@-]+)?)?/i,
  );
  const raw = match?.[1]?.trim();
  let rawModel = raw;
  let rawProfile: string | undefined;
  if (raw?.includes("@")) {
    const parts = raw.split("@");
    rawModel = parts[0]?.trim();
    rawProfile = parts.slice(1).join("@").trim() || undefined;
  }
  const cleaned = match
    ? body.replace(match[0], "").replace(/\s+/g, " ").trim()
    : body.trim();
  return {
    cleaned,
    rawModel,
    rawProfile,
    hasDirective: !!match,
  };
}
