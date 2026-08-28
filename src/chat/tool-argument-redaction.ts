/**
 * Tools whose raw call arguments must never be rendered to an operator.
 *
 * A tool-display entry with no detail keys only suppresses the compact summary;
 * every surface that renders raw arguments (TUI tool rows, Control UI sidebar
 * and expanded cards) needs this same fact, so it lives here rather than being
 * re-derived per surface. Pure and browser-safe: the Control UI imports it
 * directly.
 */
const REDACTED_TOOL_ARGUMENT_SUMMARIES = new Map<string, string>([
  ["delegate_artifacts_publish", "artifact paths redacted"],
]);

/** Replacement text for a tool whose arguments are redacted, if any. */
export function resolveRedactedToolArgumentSummary(toolName: string): string | undefined {
  return REDACTED_TOOL_ARGUMENT_SUMMARIES.get(toolName.trim().toLowerCase());
}
