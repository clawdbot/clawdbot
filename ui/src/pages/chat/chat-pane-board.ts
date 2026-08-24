import { html, nothing, type TemplateResult } from "lit";
import { guard } from "lit/directives/guard.js";
import { GATEWAY_SERVER_CAPS } from "../../../../packages/gateway-protocol/src/index.js";
import { hasOperatorApprovalsAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import {
  acquireBoardProviderForSession,
  boardProviderCacheKey,
  boardProviderForSession,
  type BoardCommandEvent,
  type BoardProvider,
  type BoardViewCallbacks,
} from "../../lib/board/provider.ts";
import {
  updateBoardSessionView,
  type BoardSessionView,
  type BoardVisibleChatDock,
} from "../../lib/board/settings.ts";
import type { BoardTab } from "../../lib/board/types.ts";
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
} from "../../lib/sessions/session-key.ts";
import {
  ensureBoardViewElement,
  ensureWorkboardCardChipElement,
  renderBoardSessionSurface,
  type WorkboardCardChipProps,
} from "./board-session-surface.ts";
import { ChatPaneHistory } from "./chat-pane-history.ts";
import { boardChatDockLayout, type ResolvedBoardView } from "./chat-pane-shared.ts";
import { renderChatResizableDivider } from "./components/chat-resizable-divider.ts";
import {
  SIDEBAR_NARROW_BREAKPOINT_PX,
  activatePanel,
  fitSidebarLayout,
  openSlot,
  resizeSidebarPanel,
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

  protected syncChatSidebarForDock(dock: BoardTab["chatDock"]): boolean {
    const state = this.state;
    if (!state) {
      return false;
    }
    if (dock !== "left" && dock !== "right") {
      return true;
    }
    const beforeOpen = state.sidebarLayout;
    let layout = openSlot(beforeOpen, "chat");
    const chatPanel = layout.columns
      .flatMap((column) => column.panels)
      .find((panel) => panel.slot === "chat");
    if (chatPanel) {
      layout = activatePanel(layout, chatPanel.id);
    }
    const fitted =
      this.paneWidth >= SIDEBAR_NARROW_BREAKPOINT_PX
        ? (fitSidebarLayout(layout, this.paneWidth) ?? layout)
        : layout;
    state.updateSidebarLayout(fitted);
    if (chatPanel) {
      state.updateSidebarActivePanel(chatPanel.id);
    }
    return true;
  }

  protected resolveBoardProvider(): BoardProvider {
    const sessionKey = this.resolveBoardSessionKey();
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
      const key = boardProviderCacheKey(sessionKey);
      if (this.boardProviderLease?.sessionKey !== key) {
        this.releaseBoardProviderLease();
        this.boardProviderLease = {
          ...acquireBoardProviderForSession(
            key,
            client,
            gateway.phase === "connected",
            canPinWidgets,
            canPinMcpApps,
            canMutate,
            canGrant,
          ),
          sessionKey: key,
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
    return boardProviderForSession(sessionKey, available);
  }

  protected releaseBoardProviderLease(): void {
    this.boardProviderLease?.release();
    this.boardProviderLease = undefined;
  }

  protected resolveWorkboardCardChip(board: ResolvedBoardView): WorkboardCardChipProps | null {
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
      active: board.face === "dashboard" && this.visuallyPresented,
      basePath: state.basePath,
      client,
      sessionKey: this.resolveBoardSessionKey(board.snapshot.sessionKey),
    };
  }

  protected syncRetainedBoardSession(board: ResolvedBoardView): void {
    const sessionKey = this.resolveBoardSessionKey(board.snapshot.sessionKey);
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
      board.face === "dashboard" &&
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
    void import("../../lib/sessions/swarm-roster.ts").then(
      ({ isSwarmEnabledInConfig, SwarmRosterHydrator }) => {
        if (
          !this.state ||
          !this.presented ||
          this.state.connectionEpoch !== sourceEpoch ||
          parentKey !== this.resolveBoardSessionKey()
        ) {
          return;
        }
        const enabled =
          this.state.connected &&
          isSwarmEnabledInConfig(
            this.context.runtimeConfig?.state.configSnapshot?.config,
            resolveAgentIdFromSessionKey(parentKey),
          );
        if (!enabled) {
          this.swarmHydrator?.dispose();
          this.swarmHydrator = null;
          this.requestUpdate();
          return;
        }
        this.swarmHydrator ??= new SwarmRosterHydrator();
        this.swarmHydrator.update({
          sessions: this.context.sessions,
          parentKey,
          sourceEpoch,
          currentRows: () =>
            this.state?.connectionEpoch === sourceEpoch
              ? (this.state.sessionsResult?.sessions ?? [])
              : [],
          onRows: () => this.requestUpdate(),
        });
      },
    );
  }

  protected resolveBoardView(): ResolvedBoardView {
    const provider = this.resolveBoardProvider();
    const snapshot = provider.snapshot$.value;
    const hasBoard = snapshot.tabs.length > 0 || snapshot.widgets.length > 0;
    const sessionKey = this.resolveBoardSessionKey(snapshot.sessionKey);
    const saved =
      loadSettings().boardSessionViews?.[sessionKey] ??
      this.state?.settings?.boardSessionViews?.[sessionKey];
    const savedTab = snapshot.tabs.some((tab) => tab.tabId === saved?.activeTabId)
      ? saved?.activeTabId
      : undefined;
    const activeTabId = savedTab ?? snapshot.tabs[0]?.tabId ?? snapshot.widgets[0]?.tabId ?? "";
    const tab = snapshot.tabs.find((candidate) => candidate.tabId === activeTabId);
    const commandDock =
      this.boardCommandDock?.sessionKey === sessionKey &&
      this.boardCommandDock.tabId === activeTabId
        ? this.boardCommandDock.dock
        : undefined;
    const dock = commandDock ?? tab?.chatDock ?? "right";
    const dockKey = `${sessionKey}:${activeTabId}`;
    if (dock !== "hidden") {
      this.lastVisibleBoardDock.set(dockKey, dock);
    }
    return {
      provider,
      snapshot,
      hasBoard,
      face: hasBoard ? this.routeFace : "chat",
      activeTabId,
      dock,
      reopenDock:
        this.lastVisibleBoardDock.get(dockKey) ?? saved?.reopenDockByTab?.[activeTabId] ?? "right",
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
    const settings = this.state?.settings;
    const persistedSettings = loadSettings();
    const boardSessionViews = {
      ...settings?.boardSessionViews,
      ...persistedSettings.boardSessionViews,
    };
    const next = patchSettings({
      boardSessionViews: updateBoardSessionView(boardSessionViews, sessionKey, persistedPatch),
    });
    if (this.state) {
      this.state.settings = next;
    }
    this.requestUpdate();
  }

  protected renderBoardPrimary(board: ResolvedBoardView, chat: TemplateResult) {
    const sessionKey = this.resolveBoardSessionKey(board.snapshot.sessionKey);
    const shouldRender =
      board.hasBoard &&
      Boolean(sessionKey) &&
      (board.face === "dashboard" || this.retainedBoardSessionKey === sessionKey);
    const boardActive = board.face === "dashboard" && this.visuallyPresented;
    const renderSurface = (active: boolean) =>
      renderBoardSessionSurface({
        active,
        snapshot: board.snapshot,
        activeTabId: board.activeTabId,
        dock: board.dock,
        dockSize: this.boardChatDockSize,
        chat,
        divider: this.renderBoardDivider("bottom"),
        canMutate: board.provider.canMutate,
        canGrant: board.provider.canGrant,
        callbacks: {
          applyOps: (ops) => board.provider.applyOps(ops),
          grant: (name, decision) => board.provider.grant(name, decision),
          selectTab: (tabId) => {
            this.boardCommandDock = null;
            this.persistBoardSessionView({ face: "dashboard", activeTabId: tabId });
          },
          frameLoadFailed: (name) => board.provider.refreshWidgetFrame(name),
          widgetAppView: (name, revision) => board.provider.widgetAppView(name, revision),
          refreshWidgetAppView: (name, revision) =>
            board.provider.refreshWidgetAppView(name, revision),
        } satisfies BoardViewCallbacks,
        widgetFrameUrl: (name, revision) => board.provider.widgetFrameUrl(name, revision),
        workboardCardChip: this.resolveWorkboardCardChip(board),
      });
    const boardSurface = !shouldRender
      ? nothing
      : boardActive
        ? renderSurface(true)
        : guard([sessionKey], () => renderSurface(false));
    return html`${boardActive ? nothing : chat}${boardSurface}`;
  }

  protected persistBoardReopenDock(board: ResolvedBoardView, dock: BoardVisibleChatDock): void {
    if (!board.activeTabId) {
      return;
    }
    const sessionKey = this.resolveBoardSessionKey(board.snapshot.sessionKey);
    const saved =
      loadSettings().boardSessionViews?.[sessionKey] ??
      this.state?.settings?.boardSessionViews?.[sessionKey];
    this.persistBoardSessionView({
      reopenDockByTab: {
        ...saved?.reopenDockByTab,
        [board.activeTabId]: dock,
      },
    });
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
        this.boardCommandDock = null;
        this.persistBoardSessionView({ face: "dashboard", activeTabId: command.tabId });
      }
      return;
    }
    if (!board.activeTabId) {
      return;
    }
    const reopenDock = command.dock === "hidden" ? board.reopenDock : command.dock;
    if (!this.syncChatSidebarForDock(command.dock)) {
      return;
    }
    this.persistBoardReopenDock(board, reopenDock);
    this.boardCommandDock = {
      sessionKey,
      tabId: board.activeTabId,
      dock: command.dock,
    };
    if (command.dock !== "hidden") {
      this.lastVisibleBoardDock.set(`${sessionKey}:${board.activeTabId}`, command.dock);
    }
  }

  protected handleBoardDockChange(dock: BoardTab["chatDock"]): void {
    const board = this.resolveBoardView();
    if (!board.activeTabId || !board.provider.canMutate) {
      return;
    }
    const sessionKey = this.resolveBoardSessionKey(board.snapshot.sessionKey);
    if (!this.syncChatSidebarForDock(dock)) {
      return;
    }
    this.boardCommandDock = null;
    const reopenDock = dock === "hidden" ? board.reopenDock : dock;
    this.lastVisibleBoardDock.set(`${sessionKey}:${board.activeTabId}`, reopenDock);
    this.persistBoardReopenDock(board, reopenDock);
    const owner = this.headerOutcomeOwner;
    void board.provider
      .applyOps([{ kind: "tab_update", tabId: board.activeTabId, chatDock: dock }])
      .catch((error: unknown) => this.publishHeaderError(error, owner));
  }

  protected renderBoardDivider(dock: BoardVisibleChatDock) {
    return renderChatResizableDivider({
      className: "board-session-surface__divider",
      orientation: dock === "bottom" ? "horizontal" : "vertical",
      splitRatio: 0.5,
      minRatio: 0.2,
      maxRatio: 0.8,
      label: t("chat.board.resizeDock"),
      onElement: (element) => {
        if (!(element instanceof HTMLElement)) {
          return;
        }
        queueMicrotask(() => {
          const previous = element.previousElementSibling?.getBoundingClientRect();
          const next = element.nextElementSibling?.getBoundingClientRect();
          const previousSize = dock === "bottom" ? (previous?.height ?? 0) : (previous?.width ?? 0);
          const nextSize = dock === "bottom" ? (next?.height ?? 0) : (next?.width ?? 0);
          const total = previousSize + nextSize;
          if (total > 0) {
            (element as HTMLElement & { splitRatio: number }).splitRatio =
              (dock === "left" ? nextSize : previousSize) / total;
          }
        });
      },
      onResize: (event) => this.handleBoardDockResize(dock, event),
    });
  }

  protected handleBoardDockResize(
    dock: BoardVisibleChatDock,
    event: CustomEvent<{ splitRatio: number }>,
  ): void {
    if (dock !== "bottom") {
      return;
    }
    const divider = event.currentTarget as HTMLElement | null;
    const previous = divider?.previousElementSibling?.getBoundingClientRect();
    const next = divider?.nextElementSibling?.getBoundingClientRect();
    const total =
      dock === "bottom"
        ? (previous?.height ?? 0) + (next?.height ?? 0)
        : (previous?.width ?? 0) + (next?.width ?? 0);
    if (total <= 0) {
      return;
    }
    this.boardChatDockSize = {
      ...this.boardChatDockSize,
      height: Math.min(
        boardChatDockLayout.maxHeight(),
        Math.max(boardChatDockLayout.minHeight, total * (1 - event.detail.splitRatio)),
      ),
    };
    boardChatDockLayout.save({
      ...boardChatDockLayout.load(),
      ...this.boardChatDockSize,
      open: true,
      dock,
    });
  }
}
