import "./claude-live-registry.js";

/** Resets the process registry between live-session tests. */
export function resetClaudeLiveSessionsForTest(): void {
  const reset = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.claudeLiveRegistryReset")
  ];
  if (typeof reset !== "function") {
    throw new Error("Claude live registry reset seam is unavailable");
  }
  reset();
}
