import { isRecord } from "openclaw/plugin-sdk/text-runtime";
import { normalizeXaiModelId } from "../model-id.js";

export { isRecord };

export function coerceXaiToolConfig(
  config: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return isRecord(config) ? config : {};
}

export function resolveNormalizedXaiToolModel(params: {
  config?: Record<string, unknown>;
  defaultModel: string;
}): string {
  const value = coerceXaiToolConfig(params.config).model;
  return typeof value === "string" && value.trim()
    ? normalizeXaiModelId(value.trim())
    : params.defaultModel;
}

export function resolvePositiveIntegerToolConfig(
  config: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const raw = coerceXaiToolConfig(config)[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  const normalized = Math.trunc(raw);
  return normalized > 0 ? normalized : undefined;
}
