// Normalizes queue config values from user and persisted settings.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { QueueDropPolicy, QueueMode } from "./types.js";

/** Normalizes user-entered queue mode aliases from directives/config. */
export function normalizeQueueMode(raw?: string): QueueMode | undefined {
  const cleaned = normalizeOptionalLowercaseString(raw);
  if (!cleaned) {
    return undefined;
  }
  if (cleaned === "interrupt" || cleaned === "interrupts" || cleaned === "abort") {
    return "interrupt";
  }
  if (cleaned === "steer" || cleaned === "steering") {
    return "steer";
  }
  if (cleaned === "followup" || cleaned === "follow-ups" || cleaned === "followups") {
    return "followup";
  }
  if (cleaned === "collect" || cleaned === "coalesce") {
    return "collect";
  }
  return undefined;
}

/** Normalizes persisted legacy queue mode aliases into current queue modes. */
export function normalizePersistedQueueMode(raw?: string): QueueMode | undefined {
  const normalized = normalizeQueueMode(raw);
  if (normalized) {
    return normalized;
  }
  const cleaned = normalizeOptionalLowercaseString(raw);
  if (cleaned === "queue" || cleaned === "queued") {
    return "steer";
  }
  if (cleaned === "steer+backlog" || cleaned === "steer-backlog" || cleaned === "steer_backlog") {
    return "followup";
  }
  return undefined;
}

/** Normalizes queue drop policy aliases from directives/config. */
export function normalizeQueueDropPolicy(raw?: string): QueueDropPolicy | undefined {
  const cleaned = normalizeOptionalLowercaseString(raw);
  if (!cleaned) {
    return undefined;
  }
  if (cleaned === "old" || cleaned === "oldest") {
    return "old";
  }
  if (cleaned === "new" || cleaned === "newest") {
    return "new";
  }
  if (cleaned === "summarize" || cleaned === "summary") {
    return "summarize";
  }
  return undefined;
}
