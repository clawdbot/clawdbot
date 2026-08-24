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

/** Builds the two rail models and their shared sidebar slot controls. */
export function createChatPaneRails(params: {
  state: ChatPageHost;
  sidebarLayout: ChatPaneSidebarLayout;
  paneWidth: number;
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
  const progressCardInRail =
    params.paneWidth >= SIDEBAR_NARROW_BREAKPOINT_PX &&
    isSidebarSlotVisible(sidebarLayout, "companion");
  return {
    backgroundTasks,
    closePanelSlot,
    openPanelSlot,
    progressCardInRail,
    sessionWorkspace,
  };
}
