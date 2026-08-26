import { isDesktopPanelAvailable } from "../../app/app-shell-chrome.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createBackgroundTasksProps } from "./components/chat-background-tasks.ts";
import { openTaskDetailId } from "./components/chat-detail-slot.ts";
import { createSessionWorkspaceProps } from "./components/chat-session-workspace.ts";
import {
  SIDEBAR_NARROW_BREAKPOINT_PX,
  closeSlot,
  isSidebarSlotVisible,
  openSlot,
  type SidebarSlotId,
} from "./sidebar-layout.ts";

type ChatPaneSidebarLayout = Parameters<typeof isSidebarSlotVisible>[0];
type ChatPaneGatewaySnapshot = Parameters<typeof isDesktopPanelAvailable>[0];

export type ChatProgressCardPlacement = "composer" | "dock" | "rail";

/* Narrowest gutter that still clears the composer: the dock is a fixed
 * --chat-progress-dock-width (250px) inside .chat-gutter-stack, which holds it
 * 14px off the pane edge and a --space-3 gap clear of the composer. */
const PROGRESS_CARD_DOCK_MIN_GUTTER_PX = 280;

/** Picks the single live progress-card placement for one chat pane. */
function chatProgressCardPlacement(params: {
  companionRailVisible: boolean;
  composerGutter: number;
}): ChatProgressCardPlacement {
  if (params.companionRailVisible) {
    return "rail";
  }
  return params.composerGutter >= PROGRESS_CARD_DOCK_MIN_GUTTER_PX ? "dock" : "composer";
}

/** Builds the two rail models and their shared sidebar slot controls. */
export function createChatPaneRails(params: {
  state: ChatPageHost;
  sidebarLayout: ChatPaneSidebarLayout;
  paneWidth: number;
  composerGutter: number;
  presentationId: string;
  presented: boolean;
  gatewaySnapshot: ChatPaneGatewaySnapshot;
  setObserverVisibility: (visible: boolean) => void;
}) {
  const { state, sidebarLayout } = params;
  const hasPanelSlot = (slot: SidebarSlotId) =>
    sidebarLayout.columns[0]?.panels.some((panel) => panel.slot === slot) === true;
  const openPanelSlot = (slot: SidebarSlotId) => {
    state.updateSidebarLayout(openSlot(state.sidebarLayout, slot));
    if (slot === "companion") {
      params.setObserverVisibility(true);
    }
  };
  const closePanelSlot = (slot: SidebarSlotId) => {
    if (slot === "companion") {
      params.setObserverVisibility(false);
    }
    state.updateSidebarLayout(closeSlot(state.sidebarLayout, slot));
  };
  const togglePanelSlot = (slot: SidebarSlotId) =>
    hasPanelSlot(slot) ? closePanelSlot(slot) : openPanelSlot(slot);
  const sessionWorkspaceBase = createSessionWorkspaceProps(state, {
    draftScope: params.presentationId,
    expanded: hasPanelSlot("workspace"),
    narrowLayout: false,
    presented: params.presented,
  });
  const sessionWorkspace = {
    ...sessionWorkspaceBase,
    collapsed: !hasPanelSlot("workspace"),
    narrowLayout: false,
    onToggleCollapsed: () => togglePanelSlot("workspace"),
    onToggleTerminal: state.terminalAvailable ? () => togglePanelSlot("terminal") : undefined,
    onToggleBrowser: state.browserPanelAvailable ? () => togglePanelSlot("browser") : undefined,
    onToggleDesktop: isDesktopPanelAvailable(params.gatewaySnapshot)
      ? () => togglePanelSlot("desktop")
      : undefined,
  };
  const backgroundTasksBase = createBackgroundTasksProps(state, {
    narrowLayout: false,
    openTaskId: openTaskDetailId(state.sidebarContent, sidebarLayout),
    onOpenTaskDetail: (task) => state.handleOpenSidebar({ kind: "task", taskId: task.id }),
    presented: params.presented,
  });
  const backgroundTasks = {
    ...backgroundTasksBase,
    collapsed: !hasPanelSlot("tasks"),
    narrowLayout: false,
    onToggleCollapsed: () => togglePanelSlot("tasks"),
  };
  const progressCardPlacement = chatProgressCardPlacement({
    companionRailVisible:
      params.paneWidth >= SIDEBAR_NARROW_BREAKPOINT_PX &&
      isSidebarSlotVisible(sidebarLayout, "companion"),
    composerGutter: params.composerGutter,
  });
  return {
    backgroundTasks,
    closePanelSlot,
    openPanelSlot,
    progressCardPlacement,
    sessionWorkspace,
  };
}
