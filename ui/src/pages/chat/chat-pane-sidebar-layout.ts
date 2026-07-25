import { html, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import type {
  SidebarPanelTemplates,
  SidebarRegionCallbacks,
} from "./components/chat-sidebar-region.ts";
import type {
  DetailFullMessageResult,
  SidebarFullMessageRequest,
} from "./components/chat-sidebar.ts";
import {
  closeSlot,
  detachPanelToColumn,
  fitSidebarLayout,
  openSlot,
  type SidebarLayout,
} from "./sidebar-layout.ts";
import "./components/chat-sidebar-region.ts";

const DETAIL_FULL_MESSAGE_MAX_CHARS = 500_000;

export function renderSidebarRegion(params: {
  availableWidth: number;
  callbacks: SidebarRegionCallbacks;
  discussionOpenUrl: string | null;
  focusPanelId: string;
  focusVersion: number;
  layout: SidebarLayout;
  narrow: boolean;
  panelTemplates: SidebarPanelTemplates;
  primary: TemplateResult;
  sessionKey: string;
}): TemplateResult {
  return html`<openclaw-chat-sidebar-region
    .layout=${params.layout}
    .primary=${params.primary}
    .panelTemplates=${params.panelTemplates}
    .panelOpenUrls=${{ discussion: params.discussionOpenUrl }}
    .callbacks=${params.callbacks}
    .sessionKey=${params.sessionKey}
    .focusPanelId=${params.focusPanelId}
    .focusVersion=${params.focusVersion}
    .narrow=${params.narrow}
    .availableWidth=${params.availableWidth}
  ></openclaw-chat-sidebar-region>`;
}

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
      maxChars: DETAIL_FULL_MESSAGE_MAX_CHARS,
    });
  };
}
