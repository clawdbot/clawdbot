import type { BoardSnapshot } from "@openclaw/gateway-protocol";
import { sliceCodePoints } from "@openclaw/normalization-core/code-points";

export function emptyBoardSnapshot(sessionKey: string): BoardSnapshot {
  return { sessionKey, revision: 0, tabs: [], widgets: [] };
}

export function normalizeBoardWidgetTitle(title: string | undefined): string | undefined {
  const normalized = title?.trim() ?? "";
  return normalized ? sliceCodePoints(normalized, 0, 80) : undefined;
}
