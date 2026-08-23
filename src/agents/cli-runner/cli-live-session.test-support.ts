import "./cli-live-session-registry.js";

/** Resets the process registry between live-session tests. */
export function resetCliLiveSessionsForTest(): void {
  const reset = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.cliLiveRegistryReset")
  ];
  if (typeof reset !== "function") {
    throw new Error("CLI live registry reset seam is unavailable");
  }
  reset();
}
