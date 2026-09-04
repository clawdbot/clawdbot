import { buildControlUiFocusPath } from "@openclaw/session-url-contract";
import { html, nothing } from "lit";
import "./chat-outbox-recovery.ts";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { isDesktopPanelAvailable } from "../../app/panel-availability.ts";
import { latestBrowserTabCards } from "../../lib/chat/browser-tab-preview.ts";
import { storedChatOutboxScopeKey } from "../../lib/chat/outbox-store.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { resolveSessionWorkspace } from "../../lib/sessions/workspace.ts";
import "../../plugins/control-ui-contributions.ts";
import { ChatPaneBrowserAnnotationRender } from "./chat-pane-browser-annotation-render.ts";
import {
  availableSidebarSlots,
  sidebarPanelActions,
  sidebarPanelDefinitions,
  sidebarPanelTemplates,
} from "./chat-pane-embedded-panels.ts";
import { resolveChatPaneDesktopTarget } from "./chat-pane-placement.ts";
import { CHAT_COMPOSER_TEXTAREA_SELECTOR, type ResolvedBoardView } from "./chat-pane-shared.ts";
import { renderSidebarRegion, sidebarRegionCallbacks } from "./chat-pane-sidebar-layout.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { renderChat, type ChatProps } from "./chat-view.ts";
import { publishChatWorkContext } from "./chat-work-context.ts";
import { renderBackgroundTasksRail } from "./components/chat-background-tasks-render.ts";
import type { BackgroundTasksProps } from "./components/chat-background-tasks.types.ts";
import { renderChatDetailSlot } from "./components/chat-detail-slot.ts";
import { renderChatImageLightbox } from "./components/chat-image-lightbox.ts";
import {
  renderSessionWorkspaceRail,
  type SessionWorkspaceProps,
} from "./components/chat-session-workspace.ts";
import { appendChatDraftText } from "./input-history.ts";
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
  private desktopFocus: {
    key: string;
    client: ChatPageHost["client"];
    href: string;
  } | null = null;

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
    if (this.inputRegion === "page") {
      const file =
        state.sidebarContent?.kind === "file" && isSidebarSlotVisible(sidebarLayout, "detail")
          ? state.sidebarContent
          : undefined;
      const workspace = resolveSessionWorkspace({
        session: selectedSession,
        agentWorkspace,
        worktreePath: selectedSession?.worktree
          ? this.headerWorktreePaths.get(selectedSession.worktree.id)?.path
          : undefined,
      });
      publishChatWorkContext(
        this.context,
        this,
        this.presented && this.selected
          ? {
              sessionKey: state.sessionKey,
              sessionId: state.currentSessionId ?? undefined,
              agentId: currentAgentId,
              workspace: file?.root ?? workspace.root ?? undefined,
              file: file?.path,
            }
          : undefined,
      );
    }
    // Accessories belong to the shared header and remain presented in visible,
    // unfocused panes; docked chat must not mount another copy.
    const header = this.compact
      ? nothing
      : html`${this.renderPaneHeader(
            sessionWorkspace,
            backgroundTasks,
            selectedSession,
            catalog,
            agentWorkspace,
            workspaceGit,
            chatProps.placementStartup,
            sidebarLayout,
          )}<openclaw-plugin-contributions
            .kind=${"session-header"}
            .sessionKey=${state.sessionKey}
            .agentId=${currentAgentId}
            .presented=${this.visuallyPresented}
          ></openclaw-plugin-contributions>`;
    const recovery = html`<openclaw-chat-outbox-recovery
      .host=${state}
      .identity=${JSON.stringify([
        state.settings.gatewayUrl,
        state.connected && state.client?.recoveryScopeReady ? state.client.recoveryScope : null,
        storedChatOutboxScopeKey(resolveUiConversationIdentity(state, state.sessionKey)),
      ])}
      @outbox-restored=${() => {
        this.chatState.restoreComposer();
        state.requestUpdate?.();
      }}
    ></openclaw-chat-outbox-recovery>`;
    const chat = renderChat({
      ...chatProps,
      presented: this.active && this.presented,
      browserTabPreviewsActive: this.active && this.presented,
      historyState: catalog ? undefined : state,
      header: nothing,
    });
    const primary = html`<div class="chat-pane-primary-column">${chat}</div>`;
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
    const desktopSource = resolveChatPaneDesktopTarget(selectedSession);
    const desktopFocusKey = JSON.stringify([
      state.sessionKey,
      this.connectionGeneration,
      desktopAvailable,
      desktopPresented,
      state.basePath,
    ]);
    if (this.desktopFocus?.key !== desktopFocusKey || this.desktopFocus.client !== state.client) {
      this.desktopFocus = {
        key: desktopFocusKey,
        client: state.client,
        href: buildControlUiFocusPath(
          { kind: "desktop", session: state.sessionKey },
          state.basePath,
        ),
      };
    }
    const desktopFocus = this.desktopFocus;
    const panelDefinitions = sidebarPanelDefinitions({
      state,
      themeMode: this.context.theme.resolvedMode,
      agentId: currentAgentId,
      browserPresented,
      browserRefreshOnPresentation: !this.pendingPanelToggleRequests.has("browser"),
      preferredBrowserTab: [
        ...latestBrowserTabCards(chatProps.messages, chatProps.toolMessages).values(),
      ].at(-1),
      desktopPresented,
      desktopRefreshOnPresentation,
      desktopAvailable,
      desktopSource,
      desktopFocusHref: desktopFocus.href,
      onDesktopFocusTargetChange: (target) => {
        // A retained callback cannot publish a previous presentation's source or control state.
        const href = buildControlUiFocusPath(target, state.basePath);
        if (this.desktopFocus === desktopFocus && desktopFocus.href !== href) {
          desktopFocus.href = href;
          this.requestUpdate();
        }
      },
      dashboard:
        !this.compact && board.hasBoard ? this.renderBoardPanel(board, sidebarLayout) : nothing,
      workspace: renderSessionWorkspaceRail(sessionWorkspace, { embedded: true }),
      tasks: renderBackgroundTasksRail(backgroundTasks, { embedded: true }),
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
      onRefreshTasks: backgroundTasks.onRefresh,
      tasksLoading: backgroundTasks.loading,
      discussion,
      discussionAvailable,
      discussionOpenUrl: discussion?.openUrl ?? null,
      discussionSourceGeneration: this.connectionGeneration,
      pluginPanels: this.context.plugins.registrations("panels"),
      isPluginPanelPresented: (slot) =>
        this.active && this.presented && isSidebarSlotVisible(sidebarLayout, slot),
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
        appendComposerText: (text) => {
          const nextDraft = appendChatDraftText(state, text);
          state.requestUpdate?.();
          queueMicrotask(() => {
            const textarea = this.querySelector<HTMLTextAreaElement>(
              CHAT_COMPOSER_TEXTAREA_SELECTOR,
            );
            textarea?.focus({ preventScroll: true });
            textarea?.setSelectionRange(nextDraft.length, nextDraft.length);
          });
        },
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
    return html`<div class="chat-pane-layout">${header}${recovery}${content}</div>
      ${renderChatImageLightbox(
        state.imageLightbox,
        state.handleCloseImage,
      )}${this.renderResetConfirmation()}`;
  }
}
