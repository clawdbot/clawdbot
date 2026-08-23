import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { mergeChatPageChrome, mobileNavLayoutMediaQuery } from "../../app/mobile-nav-layout.ts";
import { nativeGatewaysCapability } from "../../app/native-gateways.runtime.ts";
import "../../components/resizable-divider.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { McpAppUnmountGate } from "../../components/mcp-app-unmount.ts";
import { UI_COMMAND_EVENT, type UiCommandDetail } from "../../components/panel-toggle-contract.ts";
import { t } from "../../i18n/index.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import { readSessionDragData, sessionDragActive } from "../../lib/sessions/drag.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { persistSessionBoardFace } from "./chat-board-face-persistence.ts";
import { stillOwnsCanonicalLocation } from "./chat-canonical-location.ts";
import { renderChatPagePaneCell } from "./chat-page-pane-render.ts";
import { ChatPageRetainedSessions } from "./chat-page-retained-sessions.ts";
import { closeStagedPane, resumeStagedPanes } from "./chat-pane-attachment-handoff.ts";
import { ChatViewerPresenceController } from "./chat-viewer-presence.ts";
import "../../styles/chat.css";
import "./chat-pane.ts";
import { RouteDraftComposerFocus, type ChatPaneElement } from "./route-draft-focus-handoff.ts";
import { locationWithoutDraft } from "./route-draft.ts";
import type { SessionChatRouteData } from "./route-loader.ts";
import type { ChatMessageCache } from "./session-message-cache.ts";
import {
  resolveSplitDropZone,
  splitDropIndicatorRect,
  type SplitDropRect,
  type SplitDropZone,
} from "./split-drop-zone.ts";
import {
  applyUiCommandToSplitLayout,
  closePane,
  findPane,
  insertPane,
  panesOf,
  resizeColumns,
  resizePanes,
  setActivePane,
  setPaneSession,
  singlePaneLayout,
  splitRatio,
  splitWeight,
  type ChatSplitLayout,
} from "./split-layout.ts";

type DropIndicator = { paneId: string; zone: SplitDropZone; rect: SplitDropRect };

export class ChatPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;
  @property({ attribute: false }) data!: SessionChatRouteData;
  @property({ attribute: false }) navDrawerOpen = false;
  @state() private layout: ChatSplitLayout | undefined;
  @state() private narrow = false;
  @state() private mergedChrome = false;
  @state() private dropIndicator: DropIndicator | null = null;

  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.sessions,
      (sessions, notify) => sessions.subscribe(notify),
    )
    .watch(nativeGatewaysCapability, (nativeGateways, notify) =>
      nativeGateways.subscribe(() => notify()),
    );
  private mediaQuery: MediaQueryList | null = null;
  private mobileNavMediaQuery: MediaQueryList | null = null;
  private dragDepth = 0;
  private dragFrame = 0;
  private pendingDragOver: { pane: ChatPaneElement; x: number; y: number } | null = null;
  private consumedDraftData: SessionChatRouteData | null = null;
  private readonly draftFocus = new RouteDraftComposerFocus(this);
  private readonly chatMessagesBySession: ChatMessageCache = new Map();
  private classicColumnId = "c1";
  private classicPaneId = "p1";
  private routeHref = "";
  private readonly mcpAppUnmountGate = new McpAppUnmountGate(this);
  private readonly viewerPresence = new ChatViewerPresenceController(this);
  private readonly retainedSessions = new ChatPageRetainedSessions(this, {
    context: () => this.context,
    face: () => this.data?.face ?? "chat",
    layout: () => this.layout ?? this.classicLayout(),
    selectReplacement: (paneId, sourceSessionKey, sessionKey) => {
      this.handlePaneSessionChange(paneId, sourceSessionKey, sessionKey);
    },
  });

  override connectedCallback() {
    super.connectedCallback();
    this.routeHref = window.location.href;
    this.layout = loadSettings().chatSplitLayout;
    this.mediaQuery = window.matchMedia("(max-width: 1099px)");
    this.narrow = this.mediaQuery.matches;
    this.mediaQuery.addEventListener("change", this.handleViewportChange);
    this.mobileNavMediaQuery = window.matchMedia(mobileNavLayoutMediaQuery());
    this.mergedChrome = this.resolveMergedChrome(this.mobileNavMediaQuery.matches);
    this.mobileNavMediaQuery.addEventListener("change", this.handleMobileNavViewportChange);
    this.addEventListener("dragenter", this.handleDragEnter);
    this.addEventListener("dragover", this.handleDragOver);
    this.addEventListener("dragleave", this.handleDragLeave);
    this.addEventListener("drop", this.handleDrop);
    window.addEventListener("dragend", this.handleWindowDragEnd);
    window.addEventListener(UI_COMMAND_EVENT, this.handleUiCommand);
    this.retainedSessions.connect();
    this.syncRouteAgent();
    this.syncRouteToActivePane();
    const layout = this.layout ?? this.classicLayout();
    this.viewerPresence.sync(this.context?.gateway, layout, this.narrow);
  }

  override disconnectedCallback() {
    this.retainedSessions.disconnect();
    this.viewerPresence.dispose();
    this.subscriptions.clear();
    this.mediaQuery?.removeEventListener("change", this.handleViewportChange);
    this.mediaQuery = null;
    this.mobileNavMediaQuery?.removeEventListener("change", this.handleMobileNavViewportChange);
    this.mobileNavMediaQuery = null;
    this.removeEventListener("dragenter", this.handleDragEnter);
    this.removeEventListener("dragover", this.handleDragOver);
    this.removeEventListener("dragleave", this.handleDragLeave);
    this.removeEventListener("drop", this.handleDrop);
    window.removeEventListener("dragend", this.handleWindowDragEnd);
    window.removeEventListener(UI_COMMAND_EVENT, this.handleUiCommand);
    this.clearDropIndicator();
    super.disconnectedCallback();
  }

  override updated(changedProperties: Map<PropertyKey, unknown>) {
    const layout = this.layout ?? this.classicLayout();
    resumeStagedPanes(this, layout, this.narrow);
    if (this.isConnected) {
      this.viewerPresence.sync(this.context?.gateway, layout, this.narrow);
    }
    const data = this.data;
    const activePane = this.layout ? findPane(this.layout, this.layout.activePaneId)?.pane : null;
    const activeSessionKey = this.layout ? (activePane?.sessionKey ?? null) : undefined;
    const draftRendered = this.draftFocus.rendered(data, activeSessionKey, this.consumedDraftData);
    if (changedProperties.has("data")) {
      this.routeHref = window.location.href;
      if (
        data?.canonicalLocation &&
        stillOwnsCanonicalLocation(data.canonicalLocationSource, this.consumedDraftData === data)
      ) {
        // Move a route matched under the wrong namespace to its resolved board face.
        this.context.replace(data.face ?? "chat", data.canonicalLocation);
        return;
      }
      void data?.canonicalLocationReady?.then((location) => {
        if (
          location &&
          this.isConnected &&
          this.data === data &&
          stillOwnsCanonicalLocation(data.canonicalLocationSource, this.consumedDraftData === data)
        ) {
          // A lazy canonicalization must never replace a newer route.
          this.context.replace(
            data.face ?? "chat",
            this.consumedDraftData === data ? locationWithoutDraft(location) : location,
          );
        }
      });
      this.syncRouteAgent();
      this.syncRouteToActivePane();
      this.retainedSessions.settleRoute(data.sessionKey);
    }
    if (data && draftRendered) {
      queueMicrotask(() => {
        if (this.isConnected && this.data === data && this.consumedDraftData !== data) {
          this.draftFocus.beforeDraftCleanup(data);
          this.consumedDraftData = data;
          this.updateRoute(data.sessionKey, true, data.face ?? "chat");
          this.requestUpdate();
        }
      });
    }
  }

  private readonly handleViewportChange = (event: MediaQueryListEvent) => {
    this.narrow = event.matches;
    if (event.matches) {
      this.clearDropIndicator();
    }
  };

  private resolveMergedChrome(mobileNavLayout: boolean): boolean {
    return mergeChatPageChrome(mobileNavLayout, this.closest(".shell--onboarding") !== null);
  }

  private readonly handleMobileNavViewportChange = (event: MediaQueryListEvent) => {
    this.mergedChrome = this.resolveMergedChrome(event.matches);
  };

  private readonly handleUiCommand = (event: Event) => {
    if (!(event instanceof CustomEvent)) {
      return;
    }
    const { command, sessionKey: sourceSessionKey } = event.detail as UiCommandDetail;
    if (command.kind === "navigate") {
      event.preventDefault();
      this.updateRoute(command.sessionKey);
      return;
    }
    if (command.kind !== "split" && command.kind !== "close-pane" && command.kind !== "focus") {
      return;
    }
    if (command.kind === "split" && this.narrow) {
      return;
    }

    const currentSessionKey = this.data?.sessionKey?.trim();
    const layout =
      this.layout ??
      (command.kind === "split" && currentSessionKey
        ? this.classicLayout(currentSessionKey)
        : undefined);
    if (!layout) {
      return;
    }
    if (command.kind === "close-pane") {
      const targetPane = panesOf(layout).find((pane) => pane.sessionKey === command.sessionKey);
      if (!targetPane) {
        return;
      }
      event.preventDefault();
      this.closeSplitPane(layout, targetPane.id);
      return;
    }
    const next = applyUiCommandToSplitLayout(layout, command, sourceSessionKey);
    if (next === layout) {
      return;
    }
    event.preventDefault();
    this.persistLayout(next);
    const activePane = next && findPane(next, next.activePaneId)?.pane;
    if (activePane) {
      this.updateRoute(activePane.sessionKey, true);
    }
  };

  private readonly handleDragEnter = (event: DragEvent) => {
    if (this.narrow || !sessionDragActive(event.dataTransfer)) {
      return;
    }
    this.dragDepth += 1;
  };

  private readonly handleDragOver = (event: DragEvent) => {
    if (this.narrow || !sessionDragActive(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
    const target = event.target instanceof Element ? event.target : null;
    const pane = target?.closest<ChatPaneElement>("openclaw-chat-pane");
    if (!pane || !this.contains(pane)) {
      return;
    }
    this.pendingDragOver = { pane, x: event.clientX, y: event.clientY };
    if (this.dragFrame) {
      return;
    }
    this.dragFrame = window.requestAnimationFrame(() => {
      this.dragFrame = 0;
      const pending = this.pendingDragOver;
      this.pendingDragOver = null;
      if (!pending || this.narrow || !this.isConnected) {
        return;
      }
      const indicator = this.resolveDropIndicator(pending.pane, pending.x, pending.y);
      if (!indicator) {
        return;
      }
      const current = this.dropIndicator;
      if (
        current?.paneId === indicator.paneId &&
        current.zone.kind === indicator.zone.kind &&
        (indicator.zone.kind === "center" ||
          (current.zone.kind === "edge" && current.zone.edge === indicator.zone.edge))
      ) {
        return;
      }
      this.dropIndicator = indicator;
    });
  };

  private readonly handleDragLeave = (event: DragEvent) => {
    if (this.narrow || !sessionDragActive(event.dataTransfer)) {
      return;
    }
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) {
      this.clearDropIndicator();
    }
  };

  private readonly handleDrop = (event: DragEvent) => {
    if (this.narrow || !sessionDragActive(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    const sessionKey = readSessionDragData(event.dataTransfer);
    const target = event.target instanceof Element ? event.target : null;
    const pane = target?.closest<ChatPaneElement>("openclaw-chat-pane");
    const indicator =
      (pane && this.contains(pane)
        ? this.resolveDropIndicator(pane, event.clientX, event.clientY)
        : null) ?? this.dropIndicator;
    this.clearDropIndicator();
    if (sessionKey && indicator) {
      this.applySessionDrop(sessionKey, indicator.paneId, indicator.zone);
    }
  };

  private readonly handleWindowDragEnd = () => {
    this.clearDropIndicator();
  };

  private clearDropIndicator() {
    this.dragDepth = 0;
    this.clearDropPreview();
  }

  private clearDropPreview() {
    this.pendingDragOver = null;
    if (this.dragFrame) {
      window.cancelAnimationFrame(this.dragFrame);
      this.dragFrame = 0;
    }
    this.dropIndicator = null;
  }

  private resolveDropIndicator(pane: ChatPaneElement, x: number, y: number): DropIndicator | null {
    const paneId = pane.paneId;
    const container = this.querySelector<HTMLElement>(".chat-split-view__drop-container");
    if (!paneId || !container) {
      return null;
    }
    const paneRect = pane.getBoundingClientRect();
    const zone = resolveSplitDropZone(paneRect, x, y);
    const indicatorRect = splitDropIndicatorRect(paneRect, zone);
    const containerRect = container.getBoundingClientRect();
    return {
      paneId,
      zone,
      rect: {
        left: indicatorRect.left - containerRect.left,
        top: indicatorRect.top - containerRect.top,
        width: indicatorRect.width,
        height: indicatorRect.height,
      },
    };
  }

  private syncRouteToActivePane() {
    const layout = this.layout;
    const sessionKey = this.data?.sessionKey?.trim();
    if (!layout || !sessionKey) {
      return;
    }
    const activePane = findPane(layout, layout.activePaneId)?.pane;
    if (!activePane || activePane.sessionKey === sessionKey) {
      return;
    }
    this.persistLayout(setPaneSession(layout, activePane.id, sessionKey));
  }

  private syncRouteAgent() {
    const agentId = this.data?.agentId?.trim();
    if (agentId) {
      this.context.agentSelection.set(agentId);
    }
  }

  private persistLayout(layout: ChatSplitLayout | undefined) {
    this.layout = layout;
    patchSettings({ chatSplitLayout: layout });
  }

  private updateRoute(sessionKey: string, replace = false, face = this.data.face ?? "chat") {
    const data = this.data;
    if (data?.sessionKey === sessionKey && (data.face ?? "chat") === face && !data.draft) {
      return;
    }
    const options = sessionNavigationTarget({
      context: this.context,
      face,
      sessionKey,
      agentId: data?.agentId,
      shortIdLength: data?.sessionKey === sessionKey ? data.shortId?.length : undefined,
    }).options;
    if (replace) {
      this.context.replace(face, options);
    } else {
      this.context.navigate(face, options);
    }
  }

  private applySessionDrop(sessionKey: string, paneId: string, zone: SplitDropZone): void {
    const trimmed = sessionKey.trim();
    if (!trimmed) {
      return;
    }
    const layout = this.layout;
    if (!layout) {
      if (zone.kind === "center") {
        this.updateRoute(trimmed);
        return;
      }
      const currentSessionKey = this.data?.sessionKey?.trim();
      if (!currentSessionKey) {
        return;
      }
      const next = insertPane(
        this.classicLayout(currentSessionKey),
        this.classicPaneId,
        trimmed,
        zone.edge,
      );
      this.persistLayout(next);
      this.updateRoute(trimmed, true);
      return;
    }
    const pane = findPane(layout, paneId)?.pane;
    if (!pane) {
      return;
    }
    if (zone.kind === "center") {
      if (pane.sessionKey === trimmed) {
        return;
      }
      const active = setActivePane(layout, paneId);
      this.persistLayout(setPaneSession(active, paneId, trimmed));
      this.updateRoute(trimmed, true);
      return;
    }
    this.persistLayout(insertPane(layout, paneId, trimmed, zone.edge));
    this.updateRoute(trimmed, true);
  }

  private readonly handleFocusPane = (paneId: string) => {
    const layout = this.layout;
    if (!layout || layout.activePaneId === paneId) {
      return;
    }
    const pane = findPane(layout, paneId)?.pane;
    if (!pane) {
      return;
    }
    this.persistLayout(setActivePane(layout, paneId));
    this.updateRoute(pane.sessionKey, true);
  };

  private readonly handlePaneSessionChange = (
    paneId: string,
    sourceSessionKey: string,
    sessionKey: string,
    options?: { replace?: boolean },
  ): boolean => {
    const trimmed = sessionKey.trim();
    if (!trimmed || window.location.href !== this.routeHref) {
      return false;
    }
    const resolvedLayout = this.layout ?? this.classicLayout();
    const pane = findPane(resolvedLayout, paneId)?.pane;
    if (!pane || !areUiSessionKeysEquivalent(pane.sessionKey, sourceSessionKey)) {
      return false;
    }
    if (!this.layout) {
      this.updateRoute(trimmed, options?.replace);
      return true;
    }
    if (pane.sessionKey === trimmed) {
      return true;
    }
    this.persistLayout(setPaneSession(resolvedLayout, paneId, trimmed));
    if (resolvedLayout.activePaneId === paneId) {
      this.updateRoute(trimmed, options?.replace);
    }
    return true;
  };

  private readonly handlePaneFaceChange = (
    paneId: string,
    sessionKey: string,
    face: BoardFace,
  ): void => {
    const selectedSessionKey = findPane(this.layout ?? this.classicLayout(), paneId)?.pane
      .sessionKey;
    if (!selectedSessionKey || !areUiSessionKeysEquivalent(selectedSessionKey, sessionKey)) {
      return;
    }
    if (this.layout && this.layout.activePaneId !== paneId) {
      this.persistLayout(setActivePane(this.layout, paneId));
    }
    persistSessionBoardFace(this.context, sessionKey, face);
    this.updateRoute(sessionKey, false, face);
  };

  private readonly openSplitView = () => {
    const sessionKey = this.data?.sessionKey?.trim();
    if (sessionKey) {
      this.persistLayout(
        insertPane(this.classicLayout(sessionKey), this.classicPaneId, sessionKey, "right"),
      );
    }
  };

  private handleSplit(paneId: string, direction: "right" | "down") {
    const layout = this.layout;
    const pane = layout ? findPane(layout, paneId)?.pane : null;
    if (!layout || !pane) {
      return;
    }
    this.persistLayout(insertPane(layout, paneId, pane.sessionKey, direction));
  }

  private readonly handleSplitRight = (paneId: string) => this.handleSplit(paneId, "right");
  private readonly handleSplitDown = (paneId: string) => this.handleSplit(paneId, "down");

  private closeSplitPane(layout: ChatSplitLayout, paneId: string): void {
    const survivingPane = closeStagedPane(this.context, this, layout, paneId);
    this.retainedSessions.discardPane(paneId);
    const next = closePane(layout, paneId);
    if (!next && survivingPane) {
      const survivingLocation = findPane(layout, survivingPane.id);
      if (survivingLocation) {
        this.classicColumnId = survivingLocation.column.id;
        this.classicPaneId = survivingPane.id;
      }
    }
    this.persistLayout(next);
    const activePane = next ? findPane(next, next.activePaneId)?.pane : survivingPane;
    if (activePane) {
      this.updateRoute(activePane.sessionKey, true);
    }
  }

  private readonly handleClosePane = (paneId: string) => {
    if (this.layout) {
      this.closeSplitPane(this.layout, paneId);
    }
  };

  private classicLayout(sessionKey = this.data?.sessionKey?.trim() ?? ""): ChatSplitLayout {
    return singlePaneLayout(this.classicColumnId, this.classicPaneId, sessionKey);
  }

  private renderSplitLayout(
    layout: ChatSplitLayout,
    splitMode: boolean,
    retainedSessions: ReadonlyMap<string, readonly string[]>,
  ) {
    const activeLocation = findPane(layout, layout.activePaneId);
    const rightmostPane = this.narrow ? activeLocation?.pane : layout.columns.at(-1)?.panes.at(-1);
    return html`
      <div class="chat-split-view ${this.narrow ? "chat-split-view--narrow" : ""}">
        ${repeat(
          layout.columns,
          (column) => column.id,
          (column, columnIndex) => html`
            <div
              class="chat-split-view__column ${this.narrow &&
              !column.panes.some((pane) => pane.id === layout.activePaneId)
                ? "chat-split-view__column--narrow-hidden"
                : ""}"
              style="flex: ${splitWeight(
                layout.columnWeights,
                columnIndex,
                "rendered split column weight",
              )} 1 0"
            >
              ${repeat(
                column.panes,
                (pane) => pane.id,
                (pane, paneIndex) => html`
                  ${renderChatPagePaneCell({
                    active: pane.id === layout.activePaneId,
                    chatMessagesBySession: this.chatMessagesBySession,
                    consumedDraftData: this.consumedDraftData,
                    context: this.context,
                    data: this.data,
                    draftFocus: this.draftFocus,
                    mergedChrome: this.mergedChrome,
                    narrow: this.narrow,
                    navDrawerOpen: this.navDrawerOpen,
                    onboarding: this.closest(".shell--onboarding") !== null,
                    onClosePane: splitMode ? this.handleClosePane : undefined,
                    onFaceChange: this.handlePaneFaceChange,
                    onFocusPane: this.handleFocusPane,
                    onOpenSplitView: splitMode || this.narrow ? undefined : this.openSplitView,
                    onPaneSessionChange: this.handlePaneSessionChange,
                    onSessionDeleted: this.retainedSessions.removeSession,
                    onSplitDown: splitMode ? this.handleSplitDown : undefined,
                    onSplitRight: splitMode ? this.handleSplitRight : undefined,
                    ownerKey: JSON.stringify([column.id, pane.id]),
                    pane,
                    sessionKeys: retainedSessions.get(pane.id) ?? [],
                    showGatewayPicker: pane.id === rightmostPane?.id,
                    splitMode,
                    weight: splitWeight(
                      column.paneWeights,
                      paneIndex,
                      "rendered split pane weight",
                    ),
                  })}
                  ${!this.narrow && paneIndex < column.panes.length - 1
                    ? html`
                        <resizable-divider
                          orientation="horizontal"
                          .splitRatio=${splitRatio(
                            column.paneWeights,
                            paneIndex,
                            "split pane weight",
                          )}
                          .minRatio=${0.15}
                          .maxRatio=${0.85}
                          .label=${t("nav.resize")}
                          @resize=${(event: CustomEvent<{ splitRatio: number }>) => {
                            const current = this.layout;
                            if (current) {
                              this.persistLayout(
                                resizePanes(current, column.id, paneIndex, event.detail.splitRatio),
                              );
                            }
                          }}
                        ></resizable-divider>
                      `
                    : nothing}
                `,
              )}
            </div>
            ${!this.narrow && columnIndex < layout.columns.length - 1
              ? html`
                  <resizable-divider
                    .splitRatio=${splitRatio(
                      layout.columnWeights,
                      columnIndex,
                      "split column weight",
                    )}
                    .minRatio=${0.15}
                    .maxRatio=${0.85}
                    .label=${t("nav.resize")}
                    @resize=${(event: CustomEvent<{ splitRatio: number }>) => {
                      const current = this.layout;
                      if (current) {
                        this.persistLayout(
                          resizeColumns(current, columnIndex, event.detail.splitRatio),
                        );
                      }
                    }}
                  ></resizable-divider>
                `
              : nothing}
          `,
        )}
      </div>
    `;
  }

  override render() {
    const indicator = this.dropIndicator;
    const layout = this.layout ?? this.classicLayout();
    const renderedPaneOwners = layout.columns.flatMap((column) =>
      column.panes.map((pane) => ({ columnId: column.id, pane })),
    );
    const retainedSessions = this.retainedSessions.retain(
      renderedPaneOwners.map(({ pane }) => pane),
    );
    const nextPaneKeys = new Set(
      renderedPaneOwners.flatMap(({ columnId, pane }) => {
        const ownerKey = JSON.stringify([columnId, pane.id]);
        return (retainedSessions.get(pane.id) ?? []).map((sessionKey) =>
          JSON.stringify([ownerKey, sessionKey]),
        );
      }),
    );
    const rendered = html`
      <div class="chat-split-view__drop-container">
        ${this.renderSplitLayout(layout, Boolean(this.layout), retainedSessions)}
        ${indicator
          ? html`<div
              class="chat-split-view__drop-indicator ${indicator.zone.kind === "center"
                ? "chat-split-view__drop-indicator--center"
                : ""}"
              style=${`left: ${indicator.rect.left}px; top: ${indicator.rect.top}px; width: ${indicator.rect.width}px; height: ${indicator.rect.height}px;`}
            >
              <span class="chat-split-view__drop-indicator-label"
                >${indicator.zone.kind === "center"
                  ? t("chat.splitView.dropOpenHere")
                  : t("chat.splitView.dropSplit")}</span
              >
            </div>`
          : nothing}
      </div>
    `;
    return this.mcpAppUnmountGate.render(JSON.stringify([...nextPaneKeys]), rendered, () =>
      [...this.querySelectorAll<ChatPaneElement>("openclaw-chat-pane")].filter(
        (pane) => !nextPaneKeys.has(pane.dataset.mcpAppOwnerKey ?? ""),
      ),
    );
  }
}

if (!customElements.get("openclaw-chat-page")) {
  customElements.define("openclaw-chat-page", ChatPage);
}
