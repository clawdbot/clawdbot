import {
  GATEWAY_SERVER_CAPS,
  type SessionObserverDigest,
} from "../../../../packages/gateway-protocol/src/index.js";
import { hasOperatorApprovalsAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import {
  acquireBoardProviderForSession,
  boardProviderCacheKey,
  boardProviderForSession,
  type BoardCommandEvent,
  type BoardProvider,
} from "../../lib/board/provider.ts";
import { updateBoardSessionView, type BoardSessionView } from "../../lib/board/settings.ts";
import type { BoardTab } from "../../lib/board/types.ts";
import type { BoardViewSnapshot } from "../../lib/board/view-types.ts";
import {
  isGatewayCapabilityAdvertised,
  isGatewayMethodAdvertised,
} from "../../lib/gateway-methods.ts";
import { isWorkboardEnabledInConfigSnapshot } from "../../lib/plugin-activation.ts";
import { resolveSessionKey } from "../../lib/sessions/index.ts";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  normalizeSessionKeyForUiComparison,
  resolveAgentIdFromSessionKey,
  resolveUiGlobalAliasAgentId,
} from "../../lib/sessions/session-key.ts";
import type { WorkboardCardChipProps } from "./board-session-surface.ts";
import { ChatPaneHistory } from "./chat-pane-history.ts";
import {
  boardChatDockLayout,
  type ResolvedBoardView,
  type VisibleBoardDock,
} from "./chat-pane-shared.ts";
import { renderChatResizableDivider } from "./components/chat-resizable-divider.ts";
import {
  SIDEBAR_NARROW_BREAKPOINT_PX,
  activatePanel,
  detachPanelToColumn,
  fitSidebarLayout,
  openSlot,
  resizeColumn,
  type SidebarLayout,
  type SidebarSide,
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

  protected commitSidebarPanelMove(
    layout: SidebarLayout,
    panelId: string,
    targetSide: SidebarSide,
    board: ResolvedBoardView,
  ): void {
    const panel = layout.columns
      .flatMap((column) => column.panels)
      .find((candidate) => candidate.id === panelId);
    if (panel?.slot !== "chat" || board.dock === targetSide) {
      this.commitSidebarLayout(layout);
      this.commitSidebarMovedPanelActive(panelId);
      return;
    }
    if (!board.provider.canMutate || board.activeTabReadOnly) {
      return;
    }
    this.commitSidebarLayout(layout);
    this.commitSidebarMovedPanelActive(panelId);
    this.handleBoardDockChange(targetSide);
  }

  // A move activates the panel in its destination column, but the collapsed layout
  // reads a separate persisted selection. Without this the narrow view foregrounds
  // a stale panel after a drag, and the stale choice survives reload.
  private commitSidebarMovedPanelActive(panelId: string): void {
    this.state?.updateSidebarActivePanel(panelId);
  }

  protected commitSidebarColumnResize(
    renderedLayout: SidebarLayout,
    columnId: string,
    width: number,
  ): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const resizedProjection = resizeColumn(renderedLayout, columnId, width);
    const fittedProjection =
      this.paneWidth >= SIDEBAR_NARROW_BREAKPOINT_PX
        ? (fitSidebarLayout(resizedProjection, this.paneWidth) ?? resizedProjection)
        : resizedProjection;
    const fittedWidth = fittedProjection.columns.find((column) => column.id === columnId)?.width;
    if (
      fittedWidth !== undefined &&
      state.sidebarLayout.columns.some((column) => column.id === columnId)
    ) {
      state.updateSidebarLayout(resizeColumn(state.sidebarLayout, columnId, fittedWidth));
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
    let layout = openSlot(beforeOpen, "chat", dock);
    const chatColumn = layout.columns.find((column) =>
      column.panels.some((panel) => panel.slot === "chat"),
    );
    if (chatColumn && chatColumn.side !== dock) {
      const panel = chatColumn.panels.find((candidate) => candidate.slot === "chat");
      if (panel) {
        layout = detachPanelToColumn(layout, panel.id, dock, 0);
      }
    }
    const chatPanel = layout.columns
      .flatMap((column) => column.panels)
      .find((panel) => panel.slot === "chat");
    if (chatPanel) {
      layout = activatePanel(layout, chatPanel.id);
    }
    const newColumn = layout.columns.find(
      (column) => !beforeOpen.columns.some((current) => current.id === column.id),
    );
    const fitted =
      this.paneWidth >= SIDEBAR_NARROW_BREAKPOINT_PX
        ? (fitSidebarLayout(layout, this.paneWidth, newColumn?.id) ?? layout)
        : layout;
    state.updateSidebarLayout(fitted);
    if (chatPanel) {
      state.updateSidebarActivePanel(chatPanel.id);
    }
    return true;
  }

  protected resolveBoardProvider(): BoardProvider {
    const sessionKey = resolveSessionKey(
      this.state?.sessionKey ?? this.sessionKey,
      this.context?.gateway.snapshot.hello,
    );
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
    if (
      !board.hasBoard ||
      board.face !== "dashboard" ||
      !enabled ||
      gateway?.phase !== "connected"
    ) {
      return null;
    }
    const client = gateway.client;
    const state = this.state;
    if (!client || !state) {
      return null;
    }
    return {
      basePath: state.basePath,
      client,
      sessionKey: this.resolveBoardSessionKey(board.snapshot.sessionKey),
    };
  }

  protected resolveBoardSessionKey(snapshotSessionKey = ""): string {
    const resolved = resolveSessionKey(
      snapshotSessionKey || this.state?.sessionKey || this.sessionKey,
      this.context?.gateway.snapshot.hello,
    );
    const normalized = normalizeSessionKeyForUiComparison(resolved);
    return normalized === "main" ? buildAgentMainSessionKey({ agentId: "main" }) : normalized;
  }

  protected resolveObserverDigestHistoryKey(snapshotSessionKey = "", agentId?: string): string {
    const sessionKey = this.resolveBoardSessionKey(snapshotSessionKey);
    const globalAliasAgentId = resolveUiGlobalAliasAgentId(
      {
        agentsList: this.context?.agents?.state.agentsList,
        hello: this.context?.gateway.snapshot.hello,
      },
      sessionKey,
    );
    if (sessionKey !== "global" && !globalAliasAgentId) {
      return sessionKey;
    }
    const owner = normalizeAgentId(
      agentId ??
        globalAliasAgentId ??
        this.context?.agentSelection?.state.selectedId ??
        this.state?.assistantAgentId,
    );
    return `agent:${owner}:global`;
  }

  protected refreshSwarmRoster(): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const parentKey = this.resolveBoardSessionKey();
    const sourceEpoch = state.connectionEpoch;
    void import("../../lib/sessions/swarm-roster.ts").then(
      ({ isSwarmEnabledInConfig, SwarmRosterHydrator }) => {
        if (
          !this.state ||
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

  protected refreshBuiltinBoardSnapshot(): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const parentKey = this.resolveBoardSessionKey();
    const sourceEpoch = state.connectionEpoch;
    void import("../../lib/board/builtin-dashboard.ts").then(({ withBuiltinDashboardWidgets }) => {
      if (
        !this.state ||
        this.state.connectionEpoch !== sourceEpoch ||
        parentKey !== this.resolveBoardSessionKey()
      ) {
        return;
      }
      const base = this.resolveBoardProvider().snapshot$.value;
      const sessionKey = this.resolveObserverDigestHistoryKey(base.sessionKey);
      this.builtinBoardSnapshotBase = base;
      this.builtinBoardSnapshot = withBuiltinDashboardWidgets(
        base,
        this.observerDigestHistory.get(sessionKey),
      );
      this.requestUpdate();
    });
  }

  protected recordObserverDigest(digest: SessionObserverDigest): void {
    if (
      normalizeSessionKeyForUiComparison(digest.sessionKey) === "global" &&
      !digest.agentId?.trim()
    ) {
      return;
    }
    const sessionKey = this.resolveObserverDigestHistoryKey(digest.sessionKey, digest.agentId);
    if (this.observerDigestHistory.record({ ...digest, sessionKey })) {
      this.refreshBuiltinBoardSnapshot();
    }
  }

  protected resolveBoardView(): ResolvedBoardView {
    const provider = this.resolveBoardProvider();
    const baseSnapshot = provider.snapshot$.value;
    const snapshot: BoardViewSnapshot =
      this.builtinBoardSnapshotBase === baseSnapshot
        ? (this.builtinBoardSnapshot ?? baseSnapshot)
        : baseSnapshot;
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
    const activeTabReadOnly = snapshot.widgets.some(
      (candidate) => candidate.tabId === activeTabId && candidate.readOnly === true,
    );
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
      activeTabReadOnly,
      dock,
      reopenDock:
        this.lastVisibleBoardDock.get(dockKey) ?? saved?.reopenDockByTab?.[activeTabId] ?? "right",
    };
  }

  protected persistBoardSessionView(
    patch: Partial<BoardSessionView> & { face?: "chat" | "dashboard" },
  ): void {
    if (patch.face) {
      this.onFaceChange?.(patch.face);
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

  protected persistBoardReopenDock(board: ResolvedBoardView, dock: VisibleBoardDock): void {
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
    if (!board.activeTabId || board.activeTabReadOnly || !board.provider.canMutate) {
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
    void board.provider
      .applyOps([{ kind: "tab_update", tabId: board.activeTabId, chatDock: dock }])
      .catch((error: unknown) => this.publishHeaderError(error));
  }

  protected renderBoardDivider(dock: VisibleBoardDock) {
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
    dock: VisibleBoardDock,
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
