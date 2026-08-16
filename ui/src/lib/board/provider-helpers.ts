import type { BoardSnapshot } from "@openclaw/gateway-protocol";

export function emptyBoardSnapshot(sessionKey: string): BoardSnapshot {
  return { sessionKey, revision: 0, tabs: [], widgets: [] };
}

export function normalizeBoardWidgetTitle(title: string | undefined): string | undefined {
  const normalized = title?.trim() ?? "";
  return normalized ? Array.from(normalized).slice(0, 80).join("") : undefined;
}
