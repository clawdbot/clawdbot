import { html, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type {
  SidebarPanelTemplates,
  SidebarRegionCallbacks,
} from "./components/chat-sidebar-region-types.ts";
import type { SidebarFullMessageLoader } from "./components/chat-sidebar.ts";
import {
  activatePanel,
  closeSlot,
  fitSidebarLayout,
  isSidebarRegionCollapsed,
  openSlot,
  reorderPanel,
  setSidebarDock,
  setSidebarExpanded,
  sidebarDock,
  type SidebarLayout,
  type SidebarSlotId,
} from "./sidebar-layout.ts";

const DETAIL_FULL_MESSAGE_MAX_CHARS = 500_000;
let sidebarRegionLoad: Promise<boolean> | null = null;
const panelRuntimeLoads = new Map<SidebarSlotId, Promise<unknown>>();

function ensurePanelRuntime(slot: SidebarSlotId) {
  if (panelRuntimeLoads.has(slot)) {
    return;
  }
  const load =
    slot === "terminal"
      ? import("../../components/terminal/terminal-panel-registration.ts")
      : slot === "browser"
        ? import("../../components/browser/browser-panel.ts")
        : slot === "desktop"
          ? import("../../components/desktop/desktop-panel.ts")
          : slot === "companion"
            ? import("./components/chat-session-rail.ts")
            : slot === "discussion"
              ? import("./components/session-discussion-panel.ts")
              : null;
  if (load) {
    panelRuntimeLoads.set(slot, load);
  }
}

/**
 * Region callbacks: the pure layout moves resolve here, while the pane injects
 * what only it owns — the board dock, the cached discussion url, the persisted
 * resize, and the panel's open state.
 */
export function sidebarRegionCallbacks(params: {
  state: ChatPageHost;
  closePanelSlot: (slot: SidebarSlotId) => void;
  openPanelSlot: (slot: SidebarSlotId) => void;
  hideBoard: () => void;
  forgetDiscussionUrl: () => void;
  resizePanel: (columnId: string, size: number) => void;
  setPanelOpen: (open: boolean) => void;
}): SidebarRegionCallbacks {
  const { state } = params;
  return {
    activatePanel: (panelId) => {
      state.updateSidebarLayout(activatePanel(state.sidebarLayout, panelId));
      state.updateSidebarActivePanel(panelId);
    },
    closeSlot: (slot) => {
      if (slot === "chat") {
        params.hideBoard();
        return;
      }
      if (slot === "discussion") {
        params.forgetDiscussionUrl();
      }
      params.closePanelSlot(slot);
    },
    openSlot: params.openPanelSlot,
    reorderPanel: (panelId, targetPanelId, placement) =>
      state.updateSidebarLayout(
        reorderPanel(state.sidebarLayout, panelId, targetPanelId, placement),
      ),
    resizePanel: params.resizePanel,
    setDock: (dock) => state.updateSidebarLayout(setSidebarDock(state.sidebarLayout, dock)),
    setExpanded: (expanded) =>
      state.updateSidebarLayout(setSidebarExpanded(state.sidebarLayout, expanded)),
    setOpen: params.setPanelOpen,
  };
}

export function renderSidebarRegion(params: {
  availableWidth: number;
  callbacks: SidebarRegionCallbacks;
  availableSlots: SidebarSlotId[];
  layout: SidebarLayout;
  narrow: boolean;
  panelActions: SidebarPanelTemplates;
  panelTemplates: SidebarPanelTemplates;
  primary: TemplateResult;
}): TemplateResult {
  const panelOpen = params.layout.open === true;
  if (panelOpen && !customElements.get("openclaw-chat-sidebar-region")) {
    sidebarRegionLoad ??= import("./components/chat-sidebar-region.runtime.ts").then(
      () => true,
      () => {
        sidebarRegionLoad = null;
        return false;
      },
    );
  }
  for (const panel of params.layout.columns[0]?.panels ?? []) {
    ensurePanelRuntime(panel.slot);
  }
  const availableWidth =
    params.availableWidth > 0 ? params.availableWidth : Number.POSITIVE_INFINITY;
  const collapsed = params.narrow || isSidebarRegionCollapsed(params.layout, availableWidth);
  return html`<div
    class="sidebar-region ${collapsed && panelOpen ? "sidebar-region--narrow" : ""} ${panelOpen &&
    params.layout.expanded
      ? "sidebar-region--expanded"
      : ""} ${panelOpen && sidebarDock(params.layout) === "bottom" ? "sidebar-region--bottom" : ""}"
  >
    <openclaw-chat-sidebar-region
      .layout=${params.layout}
      .panelTemplates=${params.panelTemplates}
      .panelActions=${params.panelActions}
      .availableSlots=${params.availableSlots}
      .callbacks=${params.callbacks}
      .narrow=${params.narrow}
      .availableWidth=${params.availableWidth}
    ></openclaw-chat-sidebar-region>
    <div class="sidebar-region__primary">${params.primary}</div>
    <div class="sidebar-region__right-runtime"></div>
  </div>`;
}

export function resolveSidebarLayoutForBoard(params: {
  board: ResolvedBoardView;
  layout: SidebarLayout;
  paneWidth: number;
}): SidebarLayout {
  let layout = params.layout;
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
  layout = openSlot(layout, "chat");
  return fitSidebarLayout(layout, params.paneWidth) ?? layout;
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
