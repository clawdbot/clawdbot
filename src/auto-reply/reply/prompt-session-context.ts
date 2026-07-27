import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  sessionDeliveryChannel,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.shared.js";

function normalizePromptRouteChannel(raw?: string | null): string | undefined {
  const normalized = normalizeOptionalString(raw);
  return normalized && normalized !== "none" ? normalized : undefined;
}

export function normalizeToolProgressDetail(value: unknown): "explain" | "raw" | undefined {
  return value === "explain" || value === "raw" ? value : undefined;
}

export function resolvePersistedPromptProvider(entry?: SessionEntry): string | undefined {
  return normalizePromptRouteChannel(sessionDeliveryChannel(entry));
}

export function resolvePersistedPromptSurface(entry?: SessionEntry): string | undefined {
  return (
    normalizePromptRouteChannel(sessionDeliveryOrigin(entry)?.surface) ??
    resolvePersistedPromptProvider(entry)
  );
}
