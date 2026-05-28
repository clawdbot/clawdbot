export const adjustedParamsByToolCallId = new Map<string, unknown>();

export function resetAdjustedParamsByToolCallIdForTests(): void {
  adjustedParamsByToolCallId.clear();
}
