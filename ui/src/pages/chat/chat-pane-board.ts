import {
  GATEWAY_SERVER_CAPS,
  acquireBoardProviderForSession,
  boardProviderCacheKey,
  boardProviderForSession,
  buildAgentMainSessionKey,
  hasOperatorApprovalsAccess,
  hasOperatorWriteAccess,
  isGatewayCapabilityAdvertised,
  isGatewayMethodAdvertised,
  isWorkboardEnabledInConfigSnapshot,
  loadSettings,
  normalizeSessionKeyForUiComparison,
  patchSettings,
  renderChatResizableDivider,
  resolveAgentIdFromSessionKey,
  resolveSessionKey,
  t,
  updateBoardSessionView,
  type BoardCommandEvent,
  type BoardProvider,
  type BoardSessionView,
  type BoardTab,
  type BoardViewSnapshot,
  type GatewaySessionRow,
  type SessionObserverDigest,
  type WorkboardCardChipProps,
} from "./chat-pane-deps.ts";
import { ChatPaneHistory } from "./chat-pane-history.ts";
import {
  boardChatDockLayout,
  type ResolvedBoardView,
  type VisibleBoardDock,
} from "./chat-pane-shared.ts";

export abstract class ChatPaneBoard extends ChatPaneHistory {
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
        boardProviderForSession(
          key,
          client,
          true,
          gateway.phase === "connected",
          canPinWidgets,
          canPinMcpApps,
          canMutate,
          canGrant,
        );
      }
      return this.boardProviderLease.provider;
    }
    this.releaseBoardProviderLease();
    return boardProviderForSession(
      sessionKey,
      client,
      available,
      gateway?.phase === "connected",
      canPinWidgets,
      canPinMcpApps,
      canMutate,
      canGrant,
    );
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

  protected refreshBuiltinBoardSnapshot(): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const parentKey = this.resolveBoardSessionKey();
    const sourceEpoch = state.connectionEpoch;
    void import("../../lib/board/builtin-dashboard.ts").then(
      ({ isSwarmEnabledInConfig, SwarmRosterHydrator, withBuiltinDashboardWidgets }) => {
        if (
          !this.state ||
          this.state.connectionEpoch !== sourceEpoch ||
          parentKey !== this.resolveBoardSessionKey()
        ) {
          return;
        }
        const swarmEnabled =
          this.state.connected &&
          isSwarmEnabledInConfig(
            this.context.runtimeConfig?.state.configSnapshot?.config,
            resolveAgentIdFromSessionKey(parentKey),
          );
        const applyRows = (rows: readonly GatewaySessionRow[], includeSwarm: boolean) => {
          const base = this.resolveBoardProvider().snapshot$.value;
          const sessionKey = this.resolveBoardSessionKey(base.sessionKey);
          this.builtinBoardSnapshotBase = base;
          this.builtinBoardSnapshot = withBuiltinDashboardWidgets(
            base,
            rows,
            this.observerDigestHistory.get(sessionKey),
            includeSwarm,
          );
          this.requestUpdate();
        };
        if (!swarmEnabled) {
          this.swarmHydrator?.dispose();
          this.swarmHydrator = null;
          applyRows(this.state.sessionsResult?.sessions ?? [], false);
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
          onRows: (rows) => applyRows(rows, true),
        });
      },
    );
  }

  protected recordObserverDigest(digest: SessionObserverDigest): void {
    const sessionKey = this.resolveBoardSessionKey(digest.sessionKey);
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
    const activeTabId =
      savedTab ??
      snapshot.widgets.find((candidate) => candidate.builtin === "swarm")?.tabId ??
      snapshot.tabs[0]?.tabId ??
      snapshot.widgets[0]?.tabId ??
      "";
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
      face: hasBoard ? (saved?.face ?? "chat") : "chat",
      activeTabId,
      activeTabReadOnly,
      dock,
      reopenDock:
        this.lastVisibleBoardDock.get(dockKey) ?? saved?.reopenDockByTab?.[activeTabId] ?? "right",
    };
  }

  protected persistBoardSessionView(patch: Partial<BoardSessionView>): void {
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
      boardSessionViews: updateBoardSessionView(boardSessionViews, sessionKey, patch),
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
    if (dock === "bottom") {
      this.boardChatDockSize = {
        ...this.boardChatDockSize,
        height: Math.min(
          boardChatDockLayout.maxHeight(),
          Math.max(boardChatDockLayout.minHeight, total * (1 - event.detail.splitRatio)),
        ),
      };
    } else {
      const dockRatio = dock === "left" ? event.detail.splitRatio : 1 - event.detail.splitRatio;
      this.boardChatDockSize = {
        ...this.boardChatDockSize,
        width: Math.min(
          boardChatDockLayout.maxWidth(),
          Math.max(boardChatDockLayout.minWidth, total * dockRatio),
        ),
      };
    }
    boardChatDockLayout.save({
      ...this.boardChatDockSize,
      open: true,
      dock,
    });
  }
}
