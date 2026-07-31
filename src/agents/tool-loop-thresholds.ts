export const TOOL_LOOP_WARNING_THRESHOLD = 10;

export function resolveToolLoopWarningThreshold(): number {
  // Numeric loop tuning was retired in #111382. Keep every admission path on
  // the same built-in threshold so policy rewrites cannot drift from detection.
  return TOOL_LOOP_WARNING_THRESHOLD;
}
