/**
 * Route chosen before a model call when context pressure may require compaction or truncation.
 */
export type PreemptiveCompactionRoute =
  | "fits"
  | "compact_only"
  | "truncate_tool_results_only"
  | "compact_then_truncate";
