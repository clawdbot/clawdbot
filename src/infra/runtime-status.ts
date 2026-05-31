import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

type RuntimeStatusFormatInput = {
  status?: string;
  pid?: number;
  state?: string;
  details?: string[];
};

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
