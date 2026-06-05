/**
 * Shared before_tool_call state for adjusted tool params.
 * The adapter and wrapper both consult this map so later execution can use the
 * normalized payload selected by hook processing.
 */
export const adjustedParamsByToolCallId = new Map<string, unknown>();

/** Clear adjusted tool parameters between isolated tests. */
export function resetAdjustedParamsByToolCallIdForTests(): void {
  adjustedParamsByToolCallId.clear();
}
