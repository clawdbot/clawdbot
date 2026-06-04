// Shared status text/tone formatter for memory health summaries.

/** Display tone used by memory status renderers. */
export type Tone = "ok" | "warn" | "muted";

/** Resolve vector indexing state from enabled and availability flags. */
export function resolveMemoryVectorState(vector: { enabled: boolean; available?: boolean }): {
  tone: Tone;
  state: "ready" | "unavailable" | "disabled" | "unknown";
} {
  if (!vector.enabled) {
    return { tone: "muted", state: "disabled" };
  }
  if (vector.available === true) {
    return { tone: "ok", state: "ready" };
  }
  if (vector.available === false) {
    return { tone: "warn", state: "unavailable" };
  }
  return { tone: "muted", state: "unknown" };
}

/** Resolve full-text search state from enabled and availability flags. */
export function resolveMemoryFtsState(fts: { enabled: boolean; available: boolean }): {
  tone: Tone;
  state: "ready" | "unavailable" | "disabled";
} {
  if (!fts.enabled) {
    return { tone: "muted", state: "disabled" };
  }
  return fts.available ? { tone: "ok", state: "ready" } : { tone: "warn", state: "unavailable" };
}

/** Format cache state as concise status text with optional entry count. */
export function resolveMemoryCacheSummary(cache: { enabled: boolean; entries?: number }): {
  tone: Tone;
  text: string;
} {
  if (!cache.enabled) {
    return { tone: "muted", text: "cache off" };
  }
  const suffix = typeof cache.entries === "number" ? ` (${cache.entries})` : "";
  return { tone: "ok", text: `cache on${suffix}` };
}

/** Resolve cache enabled state without count text. */
export function resolveMemoryCacheState(cache: { enabled: boolean }): {
  tone: Tone;
  state: "enabled" | "disabled";
} {
  return cache.enabled ? { tone: "ok", state: "enabled" } : { tone: "muted", state: "disabled" };
}
