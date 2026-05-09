/**
 * Redaction-sentinel guard. Throws at emit boundaries so every write
 * path is covered, not just audited consumers.
 *
 * @module @openclaw/oc-path/sentinel
 */

/** Literal marking a redacted secret. Writing it to disk is always a bug. */
export const REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";

/**
 * Thrown when emit detects the sentinel in output bytes. Fail-closed:
 * stripping would silently corrupt the file. `path` is the closest
 * OcPath-shaped pointer to the violation.
 */
export class OcEmitSentinelError extends Error {
  readonly code = "OC_EMIT_SENTINEL";
  readonly path: string;

  constructor(path: string) {
    super(`emit refused to write "${REDACTED_SENTINEL}" sentinel literal at ${path}`);
    this.name = "OcEmitSentinelError";
    this.path = path;
  }
}

// Substring match (not equality) — `prefix__OPENCLAW_REDACTED__suffix`
// still leaks the marker. No-op on non-string input.
export function guardSentinel(value: unknown, ocPath: string): void {
  if (typeof value === "string" && value.includes(REDACTED_SENTINEL)) {
    throw new OcEmitSentinelError(ocPath);
  }
}
