import { html, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import type {
  SidebarPanelTemplates,
  SidebarRegionCallbacks,
} from "./components/chat-sidebar-region-types.ts";
import type { SidebarFullMessageLoader } from "./components/chat-sidebar.ts";
import {
  closeSlot,
  detachPanelToColumn,
  fitSidebarLayout,
  isSidebarRegionCollapsed,
  openSlot,
  type SidebarColumn,
  type SidebarLayout,
  type SidebarPanel,
  type SidebarSlotId,
} from "./sidebar-layout.ts";

const DETAIL_FULL_MESSAGE_MAX_CHARS = 500_000;
let sidebarRegionLoad: Promise<boolean> | null = null;

export function renderSidebarRegion(params: {
  availableWidth: number;
  callbacks: SidebarRegionCallbacks;
  discussionOpenUrl: string | null;
  focusPanelId: string;
  focusVersion: number;
  layout: SidebarLayout;
  narrow: boolean;
  panelMutationEnabled: Partial<Record<SidebarSlotId, boolean>>;
  panelTemplates: SidebarPanelTemplates;
  primary: TemplateResult;
  sessionKey: string;
}): TemplateResult {
  const hasPanels = params.layout.columns.some((column) => column.panels.length > 0);
  if (hasPanels && !customElements.get("openclaw-chat-sidebar-region")) {
    sidebarRegionLoad ??= import("./components/chat-sidebar-region.runtime.ts").then(
      () => true,
      () => {
        sidebarRegionLoad = null;
        return false;
      },
    );
  }
  const availableWidth =
    params.availableWidth > 0 ? params.availableWidth : Number.POSITIVE_INFINITY;
  const collapsed = params.narrow || isSidebarRegionCollapsed(params.layout, availableWidth);
  return html`<div class="sidebar-region ${collapsed && hasPanels ? "sidebar-region--narrow" : ""}">
    <openclaw-chat-sidebar-region
      .layout=${params.layout}
      .panelTemplates=${params.panelTemplates}
      .panelOpenUrls=${{ discussion: params.discussionOpenUrl }}
      .panelMutationEnabled=${params.panelMutationEnabled}
      .callbacks=${params.callbacks}
      .sessionKey=${params.sessionKey}
      .focusPanelId=${params.focusPanelId}
      .focusVersion=${params.focusVersion}
      .narrow=${params.narrow}
      .availableWidth=${params.availableWidth}
    ></openclaw-chat-sidebar-region>
    <div class="sidebar-region__primary">${params.primary}</div>
    <div class="sidebar-region__right-runtime"></div>
    <div class="sidebar-region__panels-runtime"></div>
  </div>`;
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

function stableInsertionIndex(order: string[], current: string[], targetId: string): number {
  const targetIndex = order.indexOf(targetId);
  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    const currentIndex = current.indexOf(order[index]!);
    if (currentIndex >= 0) {
      return currentIndex + 1;
    }
  }
  for (let index = targetIndex + 1; index < order.length; index += 1) {
    const currentIndex = current.indexOf(order[index]!);
    if (currentIndex >= 0) {
      return currentIndex;
    }
  }
  return Math.max(0, Math.min(targetIndex, current.length));
}

export function restoreHiddenSidebarChat(params: {
  activatedPanelId: string;
  movedLayout: SidebarLayout;
  renderedLayout: SidebarLayout;
  storedLayout: SidebarLayout;
}): SidebarLayout {
  const renderedHasChat = params.renderedLayout.columns.some((column) =>
    column.panels.some((panel) => panel.slot === "chat"),
  );
  if (renderedHasChat) {
    return params.movedLayout;
  }
  let storedColumn: SidebarColumn | undefined;
  let storedPanel: SidebarPanel | undefined;
  for (const column of params.storedLayout.columns) {
    const chat = column.panels.find((panel) => panel.slot === "chat");
    if (chat) {
      storedColumn = column;
      storedPanel = chat;
      break;
    }
  }
  if (!storedColumn || !storedPanel) {
    return params.movedLayout;
  }
  if (
    params.movedLayout.columns.some((column) =>
      column.panels.some((panel) => panel.id === storedPanel.id),
    )
  ) {
    return params.movedLayout;
  }
  const existingColumnIndex = params.movedLayout.columns.findIndex(
    (column) => column.id === storedColumn.id,
  );
  if (existingColumnIndex >= 0) {
    const columns = [...params.movedLayout.columns];
    const column = columns[existingColumnIndex]!;
    const panelIndex = stableInsertionIndex(
      storedColumn.panels.map((panel) => panel.id),
      column.panels.map((panel) => panel.id),
      storedPanel.id,
    );
    const panels = [...column.panels];
    panels.splice(panelIndex, 0, storedPanel);
    const moveActivatedThisColumn = column.panels.some(
      (panel) => panel.id === params.activatedPanelId,
    );
    columns[existingColumnIndex] = {
      ...column,
      panels,
      activePanelId:
        storedColumn.activePanelId === storedPanel.id && !moveActivatedThisColumn
          ? storedPanel.id
          : column.activePanelId,
    };
    return { columns };
  }
  const columns = [...params.movedLayout.columns];
  const columnIndex = stableInsertionIndex(
    params.storedLayout.columns.map((column) => column.id),
    columns.map((column) => column.id),
    storedColumn.id,
  );
  columns.splice(columnIndex, 0, {
    ...storedColumn,
    panels: [storedPanel],
    activePanelId: storedPanel.id,
  });
  return { columns };
}

export function createSidebarFullMessageLoader(
  state: { client: GatewayBrowserClient | null; connected: boolean },
  disabled: boolean,
): SidebarFullMessageLoader | null {
  if (disabled || !state.client || !state.connected) {
    return null;
  }
  return async (request) => {
    if (!state.client || !state.connected) {
      return null;
    }
    return state.client.request("chat.message.get", {
      sessionKey: request.sessionKey,
      ...(request.agentId ? { agentId: request.agentId } : {}),
      messageId: request.messageId,
      maxChars: DETAIL_FULL_MESSAGE_MAX_CHARS,
    });
  };
}
