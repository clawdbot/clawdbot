export { asNullableRecord as asRecord } from "openclaw/plugin-sdk/text-runtime";
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
  return normalizedBody.split(/\r?\n/).some((line) => line.trim() === normalizedEventText);
}
