// Normalizes runtime status values for CLI and gateway reporting.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

type RuntimeStatusFormatInput = {
  status?: string;
  pid?: number;
  state?: string;
  details?: string[];
};

/** Formats runtime health/status text with optional pid, state, and extra diagnostic details. */
export function formatRuntimeStatusWithDetails({
  status,
  pid,
  state,
  details = [],
}: RuntimeStatusFormatInput): string {
  const runtimeStatus = status?.trim() || "unknown";
  const fullDetails: string[] = [];
  if (pid) {
    fullDetails.push(`pid ${pid}`);
  }
  const normalizedState = state?.trim();
  if (
    normalizedState &&
    // State often mirrors status from different process managers; suppressing
    // case-only duplicates keeps restart/status output readable.
    normalizeLowercaseStringOrEmpty(normalizedState) !==
      normalizeLowercaseStringOrEmpty(runtimeStatus)
  ) {
    fullDetails.push(`state ${normalizedState}`);
  }
  for (const detail of details) {
    const normalizedDetail = detail.trim();
    if (normalizedDetail) {
      fullDetails.push(normalizedDetail);
    }
  }
  return fullDetails.length > 0 ? `${runtimeStatus} (${fullDetails.join(", ")})` : runtimeStatus;
}
