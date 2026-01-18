export type Tone = "ok" | "warn" | "muted";

export function resolveMemoryVectorState(vector: { enabled: boolean; available?: boolean }): {
  tone: Tone;
  state: "ready" | "unavailable" | "disabled" | "unknown";
} {
  if (vector.enabled === false) return { tone: "muted", state: "disabled" };
  if (vector.available === true) return { tone: "ok", state: "ready" };
  if (vector.available === false) return { tone: "warn", state: "unavailable" };
  return { tone: "muted", state: "unknown" };
}

export function resolveMemoryFtsState(fts: { enabled: boolean; available: boolean }): {
  tone: Tone;
  state: "ready" | "unavailable" | "disabled";
} {
  if (fts.enabled === false) return { tone: "muted", state: "disabled" };
  return fts.available ? { tone: "ok", state: "ready" } : { tone: "warn", state: "unavailable" };
}

export function resolveMemoryCacheSummary(cache: { enabled: boolean; entries?: number }): {
  tone: Tone;
  text: string;
} {
  if (!cache.enabled) return { tone: "muted", text: "cache off" };
  const suffix = typeof cache.entries === "number" ? ` (${cache.entries})` : "";
  return { tone: "ok", text: `cache on${suffix}` };
}

export function resolveMemoryCacheState(cache: { enabled: boolean }): {
  tone: Tone;
  state: "enabled" | "disabled";
} {
  return cache.enabled ? { tone: "ok", state: "enabled" } : { tone: "muted", state: "disabled" };
}
