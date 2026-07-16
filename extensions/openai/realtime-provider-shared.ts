import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

export const trimToUndefined = normalizeOptionalString;

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readRealtimeErrorDetail(error: unknown): string {
  if (typeof error === "string" && error) {
    return error;
  }
  const message = asObjectRecord(error)?.message;
  if (typeof message === "string" && message) {
    return message;
  }
  return "Unknown error";
}

export function resolveOpenAIProviderConfigRecord(
  config: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const providers = asObjectRecord(config.providers);
  return (
    asObjectRecord(providers?.openai) ?? asObjectRecord(config.openai) ?? asObjectRecord(config)
  );
}
