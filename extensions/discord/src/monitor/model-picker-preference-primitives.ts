import { createHash } from "node:crypto";
import { normalizeProviderId } from "openclaw/plugin-sdk/model-ref-parse";

export function normalizeModelRef(raw?: string): string | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  const slashIndex = value.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= value.length - 1) {
    return null;
  }
  const provider = normalizeProviderId(value.slice(0, slashIndex));
  const model = value.slice(slashIndex + 1).trim();
  return provider && model ? `${provider}/${model}` : null;
}

export function sanitizeRecentModels(models: unknown, limit: number): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(models)) {
    return deduped;
  }
  for (const item of models) {
    const normalized = normalizeModelRef(typeof item === "string" ? item : undefined);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
    if (deduped.length >= limit) {
      break;
    }
  }
  return deduped;
}

function hashSegment(value: string, length: number): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);
}

export function buildPreferenceModelKey(scopeKey: string, modelRef: string): string {
  return `v1:${hashSegment(scopeKey, 32)}:${hashSegment(modelRef, 24)}`;
}

export function preferenceTimestampMs(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}
