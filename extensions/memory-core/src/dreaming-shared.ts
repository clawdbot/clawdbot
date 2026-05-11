export { asNullableRecord as asRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
export { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

export function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function includesSystemEventToken(cleanedBody: string, eventText: string): boolean {
  const normalizedBody = normalizeTrimmedString(cleanedBody);
  const normalizedEventText = normalizeTrimmedString(eventText);
  if (!normalizedBody || !normalizedEventText) {
    return false;
  }
  if (normalizedBody === normalizedEventText) {
    return true;
  }
  return normalizedBody.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (trimmed === normalizedEventText) {
      return true;
    }
    // Isolated cron turns wrap the payload with a `[cron:<id>] ...` prefix; strip
    // that one known wrapper before matching so the dream sentinel still triggers
    // without falling back to a broad substring match (which would let any user
    // message embedding the token surface as a dream cron firing).
    return trimmed.replace(/^\[cron:[^\]]+\]\s*/, "") === normalizedEventText;
  });
}
