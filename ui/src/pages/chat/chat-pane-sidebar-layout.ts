import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import {
  closeSlot,
  detachPanelToColumn,
  fitSidebarLayout,
  openSlot,
  type SidebarLayout,
} from "./sidebar-layout.ts";

export function resolveSidebarLayoutForBoard(params: {
  board: ResolvedBoardView;
  hasDetail: boolean;
  layout: SidebarLayout;
  paneWidth: number;
}): SidebarLayout {
  let layout = params.hasDetail ? params.layout : closeSlot(params.layout, "detail");
  const chatSide =
    params.board.hasBoard &&
    params.board.face === "dashboard" &&
    (params.board.dock === "left" || params.board.dock === "right")
      ? params.board.dock
      : null;
  if (!chatSide) {
    layout = closeSlot(layout, "chat");
    return fitSidebarLayout(layout, params.paneWidth) ?? layout;
  }
  const beforeOpen = layout;
  layout = openSlot(layout, "chat", chatSide);
  const chatColumn = layout.columns.find((column) =>
    column.panels.some((panel) => panel.slot === "chat"),
  );
  if (chatColumn && chatColumn.side !== chatSide) {
    const chatPanel = chatColumn.panels.find((panel) => panel.slot === "chat");
    if (chatPanel) {
      layout = detachPanelToColumn(layout, chatPanel.id, chatSide, 0);
    }
  }
  const newColumn = layout.columns.find(
    (column) => !beforeOpen.columns.some((current) => current.id === column.id),
  );
  return fitSidebarLayout(layout, params.paneWidth, newColumn?.id) ?? layout;
}

export function createSidebarFullMessageLoader(
  state: { client: GatewayBrowserClient | null; connected: boolean },
  disabled: boolean,
): ((request: SidebarFullMessageRequest) => Promise<DetailFullMessageResult | null>) | null {
  if (disabled) {
    return null;
  }
  return async (request) => {
    if (!state.client || !state.connected) {
      return null;
    }
    return state.client.request<DetailFullMessageResult>("chat.message.get", {
      sessionKey: request.sessionKey,
      ...(request.agentId ? { agentId: request.agentId } : {}),
      messageId: request.messageId,
      maxChars: CHAT_DETAIL_FULL_MESSAGE_MAX_CHARS,
    });
  };
}
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  CHAT_DETAIL_FULL_MESSAGE_MAX_CHARS,
  type DetailFullMessageResult,
  type SidebarFullMessageRequest,
} from "./components/chat-sidebar.ts";
