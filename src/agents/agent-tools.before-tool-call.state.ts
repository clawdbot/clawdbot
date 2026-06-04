// Tracks parameter adjustments made during before-tool-call processing by tool
// call id so the later execution path can use the normalized payload.
export const adjustedParamsByToolCallId = new Map<string, unknown>();

/** Clear adjusted tool parameters between isolated tests. */
export function resetAdjustedParamsByToolCallIdForTests(): void {
  adjustedParamsByToolCallId.clear();
}
