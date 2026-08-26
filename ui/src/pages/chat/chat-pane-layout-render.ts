import { html, nothing } from "lit";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { isDesktopPanelAvailable } from "../../app/app-shell-chrome.ts";
import { ChatPaneBrowserAnnotationRender } from "./chat-pane-browser-annotation-render.ts";
import {
  availableSidebarSlots,
  sidebarPanelActions,
  sidebarPanelDefinitions,
  sidebarPanelTemplates,
} from "./chat-pane-embedded-panels.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import { renderSidebarRegion, sidebarRegionCallbacks } from "./chat-pane-sidebar-layout.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { renderChat, type ChatProps } from "./chat-view.ts";
import { renderBackgroundTasksRail } from "./components/chat-background-tasks-render.ts";
import type { BackgroundTasksProps } from "./components/chat-background-tasks.types.ts";
import { detailSlotOpen, renderChatDetailSlot } from "./components/chat-detail-slot.ts";
import { renderChatImageLightbox } from "./components/chat-image-lightbox.ts";
import {
  renderSessionWorkspaceRail,
  type SessionWorkspaceProps,
} from "./components/chat-session-workspace.ts";
import {
  SIDEBAR_NARROW_BREAKPOINT_PX,
  isSidebarSlotVisible,
  type SidebarLayout,
  type SidebarSlotId,
} from "./sidebar-layout.ts";

type ChatPaneLayoutRenderParams = {
  state: ChatPageHost;
  selectedSession: GatewaySessionRow | undefined;
  currentAgentId: string;
  board: ResolvedBoardView;
  sidebarLayout: SidebarLayout;
  sessionWorkspace: SessionWorkspaceProps;
  backgroundTasks: BackgroundTasksProps;
  chatProps: ChatProps;
  observerDigest: SessionObserverDigest | null;
  observerRunId: string | null;
  catalog: boolean;
  agentWorkspace: string | undefined;
  workspaceGit: boolean;
  openPanelSlot: (slot: SidebarSlotId) => void;
  closePanelSlot: (slot: SidebarSlotId) => void;
};

export abstract class ChatPaneLayoutRender extends ChatPaneBrowserAnnotationRender {
  protected renderChatPaneLayout(params: ChatPaneLayoutRenderParams) {
    const {
      state,
      selectedSession,
      currentAgentId,
      board,
      sidebarLayout,
      sessionWorkspace,
      backgroundTasks,
      chatProps,
      observerDigest,
      observerRunId,
      catalog,
      agentWorkspace,
      workspaceGit,
      openPanelSlot,
      closePanelSlot,
    } = params;
    const header = this.renderPaneHeader(
      sessionWorkspace,
      backgroundTasks,
      selectedSession,
      catalog,
      agentWorkspace,
      workspaceGit,
      sidebarLayout,
    );
    const chat = renderChat({
      ...chatProps,
      historyState: catalog ? undefined : state,
      header: board.face === "dashboard" ? nothing : header,
    });
    // Keep this root stable across board face changes so the guarded board runtime
    // remains connected while Chat is active.
    const primary = html`<div class="chat-pane-primary-column">
      ${board.face === "dashboard" ? header : nothing}${this.renderBoardPrimary(board, chat)}
    </div>`;
    const discussion = this.buildSessionDiscussionPanel(state, state.sessionKey.trim());
    const discussionState = this.sessionDiscussionStates.get(state.sessionKey.trim());
    const discussionAvailable = discussionState === "available" || discussionState === "open";
    const desktopAvailable = isDesktopPanelAvailable(this.context.gateway.snapshot);
    const companionThread = this.sessionCompanionThreads.view(state.sessionKey, currentAgentId);
    const browserPresented =
      this.active && this.presented && isSidebarSlotVisible(sidebarLayout, "browser");
    const desktopPresented =
      this.active && this.presented && isSidebarSlotVisible(sidebarLayout, "desktop");
    const desktopRefreshOnPresentation = !this.pendingPanelToggleRequests.has("desktop");
    const panelDefinitions = sidebarPanelDefinitions({
      state,
      themeMode: this.context.theme.resolvedMode,
      agentId: currentAgentId,
      browserPresented,
      desktopPresented,
      desktopRefreshOnPresentation,
      desktopAvailable,
      hasBoard: board.hasBoard,
      chat,
      workspace: renderSessionWorkspaceRail(sessionWorkspace, { embedded: true }),
      tasks: renderBackgroundTasksRail(backgroundTasks, { embedded: true }),
      detailOpen: this.presented && sidebarLayout.open === true && detailSlotOpen(sidebarLayout),
      renderDetail: (content) =>
        renderChatDetailSlot({
          backgroundTasks,
          chat: chatProps,
          content,
          host: state,
          layout: sidebarLayout,
          transcript: this.taskSidebarTranscript,
        }),
      digest: observerDigest,
      activeRunId: observerRunId,
      startedAt: selectedSession?.startedAt ?? state.chatStreamStartedAt ?? undefined,
      lastReadAt: selectedSession?.lastReadAt,
      pullRequests: this.sessionPullRequests,
      companion: companionThread,
      onCompanionSubmit: (question) => void this.submitSessionCompanionQuestion(question),
      onCompanionDraftChange: (draft) =>
        this.sessionCompanionThreads.setDraft(state.sessionKey, draft, currentAgentId),
      onCompanionVisibilityChange: this.setSessionObserverVisibility,
      connected: state.connected,
      pendingQuestion: companionThread.pendingQuestion,
      onClearCompanion: () => void this.clearSessionCompanion(),
      discussion,
      discussionAvailable,
      discussionOpenUrl: discussion?.openUrl ?? null,
      discussionSourceGeneration: this.connectionGeneration,
    });
    const availableSlots = availableSidebarSlots(panelDefinitions);
    const panelTemplates = sidebarPanelTemplates(panelDefinitions);
    const panelActions = sidebarPanelActions(panelDefinitions);
    const content = renderSidebarRegion({
      availableWidth: this.paneWidth,
      availableSlots,
      callbacks: sidebarRegionCallbacks({
        state,
        layout: sidebarLayout,
        closePanelSlot,
        openPanelSlot,
        hideBoard: () => this.handleBoardDockChange("hidden"),
        forgetDiscussionUrl: () => this.sessionDiscussionOpenUrls.delete(state.sessionKey.trim()),
        resizePanel: (columnId, size) =>
          this.commitSidebarPanelResize(sidebarLayout, columnId, size),
        setPanelOpen: (open) => this.setChatSidePanelOpen(open, sidebarLayout),
      }),
      layout: sidebarLayout,
      panelDefinitions,
      panelActions,
      narrow: this.paneWidth < SIDEBAR_NARROW_BREAKPOINT_PX,
      panelTemplates,
      primary,
      requestUpdate: state.requestUpdate!,
    });
    return html`${content}${renderChatImageLightbox(
      state.imageLightbox,
      state.handleCloseImage,
    )}${this.renderResetConfirmation()}`;
  }
}
