import type { SessionBoardFace } from "../../../../src/shared/session-types.js";
import type { BoardTab } from "./types.ts";

export type BoardFace = SessionBoardFace;
// Canonical visible-dock union, derived from the protocol BoardTab shape so
// persisted settings and render code can never drift from the wire contract.
export type BoardVisibleChatDock = Exclude<BoardTab["chatDock"], "hidden">;

export type BoardSessionView = {
  activeTabId?: string;
  reopenDockByTab?: Record<string, BoardVisibleChatDock>;
};

export type BoardSessionViews = Record<string, BoardSessionView>;

const MAX_BOARD_SESSION_VIEWS = 50;

export function normalizeBoardSessionViews(value: unknown): BoardSessionViews {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const normalized: BoardSessionViews = {};
  for (const [sessionKey, rawView] of Object.entries(value)) {
    if (!sessionKey.trim() || !rawView || typeof rawView !== "object" || Array.isArray(rawView)) {
      continue;
    }
    const view = rawView as Record<string, unknown>;
    const activeTabId = typeof view.activeTabId === "string" ? view.activeTabId.trim() : "";
    const reopenDockByTab: Record<string, BoardVisibleChatDock> = {};
    if (
      view.reopenDockByTab &&
      typeof view.reopenDockByTab === "object" &&
      !Array.isArray(view.reopenDockByTab)
    ) {
      for (const [tabId, dock] of Object.entries(view.reopenDockByTab).slice(0, 50)) {
        const key = tabId.trim();
        if (key && (dock === "bottom" || dock === "left" || dock === "right")) {
          reopenDockByTab[key] = dock;
        }
      }
    }
    if (!activeTabId && Object.keys(reopenDockByTab).length === 0) {
      continue;
    }
    normalized[sessionKey] = {
      ...(activeTabId ? { activeTabId } : {}),
      ...(Object.keys(reopenDockByTab).length > 0 ? { reopenDockByTab } : {}),
    };
  }
  return normalized;
}

export function updateBoardSessionView(
  current: BoardSessionViews | undefined,
  sessionKey: string,
  patch: Partial<BoardSessionView>,
): BoardSessionViews {
  const key = sessionKey.trim();
  if (!key) {
    return normalizeBoardSessionViews(current);
  }
  const views = normalizeBoardSessionViews(current);
  const previous = views[key] ?? {};
  delete views[key];
  views[key] = {
    ...previous,
    ...patch,
  };
  return Object.fromEntries(Object.entries(views).slice(-MAX_BOARD_SESSION_VIEWS));
}
