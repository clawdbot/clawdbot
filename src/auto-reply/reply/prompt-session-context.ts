import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../../config/sessions/types.js";

function normalizePromptRouteChannel(raw?: string | null): string | undefined {
  const normalized = normalizeOptionalString(raw);
  return normalized && normalized !== "none" ? normalized : undefined;
}

export function normalizeToolProgressDetail(value: unknown): "explain" | "raw" | undefined {
  return value === "explain" || value === "raw" ? value : undefined;
}

export function resolvePersistedPromptProvider(entry?: SessionEntry): string | undefined {
  return (
    normalizePromptRouteChannel(entry?.origin?.provider) ??
    normalizePromptRouteChannel(entry?.channel) ??
    normalizePromptRouteChannel(entry?.lastChannel) ??
    normalizePromptRouteChannel(entry?.deliveryContext?.channel)
  );
}

export function resolvePersistedPromptSurface(entry?: SessionEntry): string | undefined {
  return (
    normalizePromptRouteChannel(entry?.origin?.surface) ?? resolvePersistedPromptProvider(entry)
  );
}
