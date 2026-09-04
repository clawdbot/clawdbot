import { html, nothing } from "lit";
import { guard } from "lit/directives/guard.js";
import { GATEWAY_SERVER_CAPS } from "../../../../packages/gateway-protocol/src/index.js";
import { hasOperatorApprovalsAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { patchSettings } from "../../app/settings.ts";
import {
  acquireBoardProviderForSession,
  boardProviderCacheKey,
  boardProviderForSession,
  type BoardCommandEvent,
  type BoardProvider,
  type BoardViewCallbacks,
} from "../../lib/board/provider.ts";
import { updateBoardSessionView, type BoardSessionView } from "../../lib/board/settings.ts";
import {
  isGatewayCapabilityAdvertised,
  isGatewayMethodAdvertised,
} from "../../lib/gateway-methods.ts";
import { isWorkboardEnabledInConfigSnapshot } from "../../lib/plugin-activation.ts";
import { resolveSessionKey } from "../../lib/sessions/index.ts";
import {
  buildAgentMainSessionKey,
  normalizeSessionKeyForUiComparison,
  resolveAgentIdFromSessionKey,
  resolveUiConversationIdentity,
} from "../../lib/sessions/session-key.ts";
import {
  ensureBoardViewElement,
  ensureWorkboardCardChipElement,
  renderBoardSessionSurface,
  type WorkboardCardChipProps,
} from "./board-session-surface.ts";
import { ChatPaneHistory } from "./chat-pane-history.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import { requestChatPageUpdate } from "./chat-state-render.ts";
import {
  SIDEBAR_NARROW_BREAKPOINT_PX,
  fitSidebarLayout,
  isSidebarSlotVisible,
  openSlot,
  promoteSidebarPanel,
  sidebarMainPanel,
  resizeSidebarPanel,
  setSidebarExpanded,
  sidebarDock,
  type SidebarLayout,
} from "./sidebar-layout.ts";

export abstract class ChatPaneBoard extends ChatPaneHistory {
  protected commitSidebarLayout(layout: SidebarLayout): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const fitted =
      this.paneWidth >= SIDEBAR_NARROW_BREAKPOINT_PX
        ? (fitSidebarLayout(layout, this.paneWidth) ?? layout)
        : layout;
    state.updateSidebarLayout(fitted);
  }

  protected commitSidebarPanelResize(
    renderedLayout: SidebarLayout,
    columnId: string,
    size: number,
  ): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const resizedProjection = resizeSidebarPanel(renderedLayout, columnId, size);
    const fittedProjection =
      this.paneWidth >= SIDEBAR_NARROW_BREAKPOINT_PX
        ? (fitSidebarLayout(resizedProjection, this.paneWidth) ?? resizedProjection)
        : resizedProjection;
    const fittedColumn = fittedProjection.columns.find((column) => column.id === columnId);
    const fittedSize =
      sidebarDock(fittedProjection) === "bottom" ? fittedColumn?.height : fittedColumn?.width;
    if (
      fittedSize !== undefined &&
      state.sidebarLayout.columns.some((column) => column.id === columnId)
    ) {
      state.updateSidebarLayout(resizeSidebarPanel(state.sidebarLayout, columnId, fittedSize));
      return;
    }
    this.commitSidebarLayout(fittedProjection);
  }

  protected resolveBoardConversation() {
    return resolveUiConversationIdentity(
      {
        assistantAgentId: this.state?.assistantAgentId,
        agentsList: this.state?.agentsList,
        hello: this.context?.gateway.snapshot.hello,
      },
      this.state?.sessionKey || this.sessionKey,
    );
  }

  protected resolveBoardProvider(): BoardProvider {
    const session = this.resolveBoardConversation();
    if (this.boardProvider) {
      this.releaseBoardProviderLease();
      return this.boardProvider;
    }
    const gateway = this.context?.gateway.snapshot;
    const available = !gateway || isGatewayMethodAdvertised(gateway, "board.get") !== false;
    const canMutate = !gateway || hasOperatorWriteAccess(gateway.hello?.auth ?? null);
    const canGrant = !gateway || hasOperatorApprovalsAccess(gateway.hello?.auth ?? null);
    const canPinWidgets =
      canMutate &&
      (!gateway ||
        isGatewayCapabilityAdvertised(gateway, GATEWAY_SERVER_CAPS.BOARD_WIDGET_PUT_CANVAS_DOC) ===
          true);
    const canPinMcpApps =
      canMutate &&
      (!gateway ||
        (isGatewayMethodAdvertised(gateway, "board.widget.appView") === true &&
          isGatewayMethodAdvertised(gateway, "board.widget.put") === true));
    const client = gateway?.client;
    if (this.boardProviderLifecycleConnected && client && available) {
      const key = boardProviderCacheKey(session);
      if (this.boardProviderLease?.cacheKey !== key) {
        this.releaseBoardProviderLease();
        this.boardProviderLease = {
          ...acquireBoardProviderForSession(
            session,
            client,
            gateway.phase === "connected",
            canPinWidgets,
            canPinMcpApps,
            canMutate,
            canGrant,
          ),
          cacheKey: key,
        };
      } else {
        this.boardProviderLease.update(client, gateway.phase === "connected", {
          canPinWidgets,
          canPinMcpApps,
          canMutate,
          canGrant,
        });
      }
      return this.boardProviderLease.provider;
    }
    this.releaseBoardProviderLease();
    return boardProviderForSession(session, available);
  }

  protected releaseBoardProviderLease(): void {
    this.boardProviderLease?.release();
    this.boardProviderLease = undefined;
  }

  protected resolveWorkboardCardChip(
    board: ResolvedBoardView,
    layout = this.state?.sidebarLayout,
  ): WorkboardCardChipProps | null {
    const gateway = this.context?.gateway.snapshot;
    const enabled = isWorkboardEnabledInConfigSnapshot(
      this.context?.runtimeConfig?.state.configSnapshot,
    );
    if (!board.hasBoard || !enabled || gateway?.phase !== "connected") {
      return null;
    }
    const client = gateway.client;
    const state = this.state;
    if (!client || !state) {
      return null;
    }
    return {
      active:
        Boolean(layout && isSidebarSlotVisible(layout, "dashboard")) && this.visuallyPresented,
      basePath: state.basePath,
      client,
      sessionKey: this.resolveBoardSessionKey(board.snapshot.sessionKey),
    };
  }

  protected syncRetainedBoardSession(board: ResolvedBoardView): void {
    const sessionKey = this.resolveBoardSessionKey(board.snapshot.sessionKey);
    const routeRequestsDashboard = this.routeFace === "dashboard" || this.dashboardExpanded;
    if (!routeRequestsDashboard) {
      this.dashboardExpandedRouteKey = "";
    } else if (board.hasBoard && sessionKey && this.dashboardExpandedRouteKey !== sessionKey) {
      this.dashboardExpandedRouteKey = sessionKey;
      const savedLayout = this.context.theme.settings.sidebarSessionLayouts?.[sessionKey];
      if (this.dashboardExpanded || !savedLayout) {
        this.showDashboard(this.dashboardExpanded);
      }
    }
    if (sessionKey && board.provider.hasLoadedSnapshot) {
      const previous = this.observedBoardPresence.get(sessionKey);
      this.observedBoardPresence.set(sessionKey, board.hasBoard);
      if (previous === false && board.hasBoard && board.face === "chat") {
        this.showDashboard(false);
      }
    }
    if (!board.hasBoard || !sessionKey) {
      this.retainedBoardSessionKey = "";
    } else if (board.face === "dashboard") {
      this.retainedBoardSessionKey = sessionKey;
    } else if (this.retainedBoardSessionKey !== sessionKey) {
      this.retainedBoardSessionKey = "";
    }
    if (this.retainedBoardSessionKey === sessionKey && this.resolveWorkboardCardChip(board)) {
      void ensureWorkboardCardChipElement().catch(() => undefined);
    }
    if (
      board.hasBoard &&
      this.state &&
      isSidebarSlotVisible(this.state.sidebarLayout, "dashboard") &&
      !customElements.get("openclaw-board-view")
    ) {
      void ensureBoardViewElement().then((loaded) => {
        if (loaded) {
          this.requestUpdate();
        }
      });
    }
  }

  protected resolveBoardSessionKey(snapshotSessionKey = ""): string {
    const resolved = resolveSessionKey(
      snapshotSessionKey || this.state?.sessionKey || this.sessionKey,
      this.context?.gateway.snapshot.hello,
    );
    const normalized = normalizeSessionKeyForUiComparison(resolved);
    return normalized === "main" ? buildAgentMainSessionKey({ agentId: "main" }) : normalized;
  }

  protected refreshSwarmRoster(): void {
    const state = this.state;
    if (!state || !this.presented) {
      return;
    }
    const parentKey = this.resolveBoardSessionKey();
    const sourceEpoch = state.connectionEpoch;
    const isCurrent = () =>
      this.state === state &&
      this.presented &&
      state.connectionEpoch === sourceEpoch &&
      parentKey === this.resolveBoardSessionKey();
    void import("../../lib/sessions/swarm-roster.ts").then(
      ({ isSwarmEnabledInConfig, SwarmRosterHydrator }) => {
        if (!isCurrent()) {
          return;
        }
        const enabled =
          state.connected &&
          isSwarmEnabledInConfig(
            this.context.runtimeConfig?.state.configSnapshot?.config,
            resolveAgentIdFromSessionKey(parentKey),
          );
        if (!enabled) {
          if (this.swarmHydrator) {
            this.swarmHydrator.dispose();
            this.swarmHydrator = null;
            requestChatPageUpdate(state, "animation-frame");
          }
          return;
        }
        this.swarmHydrator ??= new SwarmRosterHydrator();
        this.swarmHydrator.update({
          sessions: this.context.sessions,
          parentKey,
          sourceEpoch,
          currentRows: () => (isCurrent() ? (state.sessionsResult?.sessions ?? []) : []),
          onRows: () => {
            if (isCurrent()) {
              requestChatPageUpdate(state, "animation-frame");
            }
          },
        });
      },
    );
  }

  protected resolveBoardView(): ResolvedBoardView {
    const provider = this.resolveBoardProvider();
    const snapshot = provider.snapshot$.value;
    const hasBoard = snapshot.tabs.length > 0 || snapshot.widgets.length > 0;
    const sessionKey = this.resolveBoardSessionKey(snapshot.sessionKey);
    const saved = this.context.theme.settings.boardSessionViews?.[sessionKey];
    const savedTab = snapshot.tabs.some((tab) => tab.tabId === saved?.activeTabId)
      ? saved?.activeTabId
      : undefined;
    const activeTabId = savedTab ?? snapshot.tabs[0]?.tabId ?? snapshot.widgets[0]?.tabId ?? "";
    return {
      provider,
      snapshot,
      hasBoard,
      face: hasBoard ? this.routeFace : "chat",
      activeTabId,
    };
  }

  protected persistBoardSessionView(
    patch: Partial<BoardSessionView> & { face?: "chat" | "dashboard" },
  ): void {
    if (patch.face) {
      this.onFaceChange?.(this.paneId, this.sessionKey, patch.face);
    }
    const persistedPatch = { ...patch };
    delete persistedPatch.face;
    if (Object.keys(persistedPatch).length === 0) {
      return;
    }
    const board = this.resolveBoardView();
    const sessionKey = this.resolveBoardSessionKey(board.snapshot.sessionKey);
    if (!sessionKey) {
      return;
    }
    const boardSessionViews = this.context.theme.settings.boardSessionViews;
    const next = patchSettings({
      boardSessionViews: updateBoardSessionView(boardSessionViews, sessionKey, persistedPatch),
    });
    if (this.state) {
      this.state.settings = next;
    }
    this.requestUpdate();
  }

  protected renderBoardPanel(board: ResolvedBoardView, layout: SidebarLayout) {
    const sessionKey = this.resolveBoardSessionKey(board.snapshot.sessionKey);
    const shouldRender = board.hasBoard && Boolean(sessionKey);
    const boardActive = isSidebarSlotVisible(layout, "dashboard") && this.visuallyPresented;
    const renderSurface = (active: boolean) =>
      renderBoardSessionSurface({
        active,
        snapshot: board.snapshot,
        activeTabId: board.activeTabId,
        canMutate: board.provider.canMutate,
        canGrant: board.provider.canGrant,
        callbacks: {
          appViewGeneration: board.provider.appViewGeneration,
          applyOps: (ops) => board.provider.applyOps(ops),
          grant: (name, decision) => board.provider.grant(name, decision),
          selectTab: (tabId) => {
            this.persistBoardSessionView({ face: "dashboard", activeTabId: tabId });
          },
          frameLoadFailed: (name) => board.provider.refreshWidgetFrame(name),
          widgetAppView: (name, revision) => board.provider.widgetAppView(name, revision),
          refreshWidgetAppView: (name, revision) =>
            board.provider.refreshWidgetAppView(name, revision),
        } satisfies BoardViewCallbacks,
        widgetFrameUrl: (name, revision) => board.provider.widgetFrameUrl(name, revision),
        workboardCardChip: this.resolveWorkboardCardChip(board, layout),
      });
    // Keep one template boundary so hiding the panel does not remount app iframes.
    const boardSurface = !shouldRender
      ? nothing
      : html`${boardActive ? renderSurface(true) : guard([sessionKey], () => renderSurface(false))}`;
    return boardSurface;
  }

  protected showDashboard(expanded: boolean): void {
    const state = this.state;
    if (!state) {
      return;
    }
    let layout = openSlot(state.sidebarLayout, "dashboard");
    if (expanded) {
      const dashboard = layout.columns[0]?.panels.find((panel) => panel.slot === "dashboard");
      if (dashboard) {
        layout = promoteSidebarPanel(layout, dashboard.id);
      }
    } else if (sidebarMainPanel(layout)?.slot === "dashboard") {
      layout = openSlot(layout, "conversation");
    }
    layout = setSidebarExpanded(layout, expanded);
    this.commitSidebarLayout(layout);
    this.persistBoardSessionView({ face: "dashboard" });
  }

  protected handleBoardCommand(event: BoardCommandEvent): void {
    if (!this.presented) {
      return;
    }
    const board = this.resolveBoardView();
    const sessionKey = this.resolveBoardSessionKey(board.snapshot.sessionKey);
    if (!sessionKey || this.resolveBoardSessionKey(event.sessionKey) !== sessionKey) {
      return;
    }
    const command = event.command;
    if (command.kind === "focus_tab") {
      if (board.snapshot.tabs.some((tab) => tab.tabId === command.tabId)) {
        this.persistBoardSessionView({ activeTabId: command.tabId });
        this.showDashboard(false);
      }
      return;
    }
    if (!board.activeTabId) {
      return;
    }
    this.showDashboard(command.dock === "hidden");
  }
}
