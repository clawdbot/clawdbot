import { consume } from "@lit/context";
import { expectDefined } from "@openclaw/normalization-core";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { mobileNavLayoutMediaQuery, shouldMergeChatChrome } from "../../app/mobile-nav-layout.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import "../../components/resizable-divider.ts";
import { McpAppUnmountGate } from "../../components/mcp-app-unmount.ts";
import { UI_COMMAND_EVENT, type UiCommandDetail } from "../../components/panel-toggle-contract.ts";
import { t } from "../../i18n/index.ts";
import { updateBoardSessionView } from "../../lib/board/settings.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { readSessionDragData, sessionDragActive } from "../../lib/sessions/drag.ts";
import { resolveSessionKey, searchForSession } from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  normalizeSessionKeyForUiComparison,
} from "../../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import "../../styles/chat.css";
import "./chat-pane.ts";
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
  type ChatSplitLayout,
  type ChatSplitPane,
} from "./split-layout.ts";

function splitWeight(weights: number[], index: number, context: string): number {
  return expectDefined(weights[index], context);
}

function splitRatio(weights: number[], index: number, context: string): number {
  const before = splitWeight(weights, index, `${context} before divider`);
  const after = splitWeight(weights, index + 1, `${context} after divider`);
  return before / (before + after);
}

type ChatRouteData = {
  sessionKey: string;
  draft?: string;
  face?: "dashboard";
};

const NARROW_SPLIT_QUERY = "(max-width: 1099px)";

type DropIndicator = { paneId: string; zone: SplitDropZone; rect: SplitDropRect };
type ChatPaneElement = HTMLElement & { paneId?: string; sessionKey?: string };

export class ChatPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;
  @property({ attribute: false }) data!: ChatRouteData;
  @state() private layout: ChatSplitLayout | undefined;
  @state() private narrow = false;
  @state() private mergedChrome = false;
  @state() private dropIndicator: DropIndicator | null = null;

  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.sessions,
    (sessions, notify) => sessions.subscribe(notify),
  );
  private mediaQuery: MediaQueryList | null = null;
  private mobileNavMediaQuery: MediaQueryList | null = null;
  // Light-DOM enter/leave events bubble from every nested child, so only clear
  // the shared preview after the whole balanced drag has left the page.
  private dragDepth = 0;
  private dragFrame = 0;
  private pendingDragOver: { pane: ChatPaneElement; x: number; y: number } | null = null;
  private consumedDraftData: ChatRouteData | null = null;
  private readonly chatMessagesBySession: ChatMessageCache = new Map();
  private classicColumnId = "c1";
  private classicPaneId = "p1";
  private readonly mcpAppUnmountGate = new McpAppUnmountGate(this);

  override connectedCallback() {
    super.connectedCallback();
    this.layout = loadSettings().chatSplitLayout;
    this.mediaQuery = window.matchMedia(NARROW_SPLIT_QUERY);
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
    this.syncRouteToActivePane();
  }

  override disconnectedCallback() {
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
    const data = this.data;
    const activePane = this.layout ? findPane(this.layout, this.layout.activePaneId)?.pane : null;
    const routeDraftWasRendered =
      Boolean(data?.draft || data?.face) &&
      this.consumedDraftData !== data &&
      (!this.layout || activePane?.sessionKey === data.sessionKey);
    if (changedProperties.has("data")) {
      this.syncRouteToActivePane();
    }
    if (data && routeDraftWasRendered) {
      // Let the matching child process the route-provided draft once, then stop
      // later focus changes from handing the same draft to another split pane.
      queueMicrotask(() => {
        if (this.isConnected && this.data === data && this.consumedDraftData !== data) {
          this.consumedDraftData = data;
          if (data.face) {
            this.applyRouteFace(data.sessionKey, data.face);
          }
          // Route drafts are one-shot actions. Once the matching pane owns the
          // text, remove it from history so reload/back cannot replay it.
          this.context.replace("chat", { search: searchForSession(data.sessionKey) });
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
    return shouldMergeChatChrome({
      mobileNavLayout,
      routeId: "chat",
      onboarding: this.closest(".shell--onboarding") !== null,
    });
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
    // Narrow viewports render single-pane and disable interactive splitting;
    // leave programmatic splits unhandled so the host falls back to navigation.
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
    const targetPane =
      command.kind === "split"
        ? undefined
        : panesOf(layout).find((pane) => pane.sessionKey === command.sessionKey);
    const survivingPane =
      command.kind === "close-pane" && targetPane
        ? panesOf(layout).find((pane) => pane.id !== targetPane.id)
        : undefined;
    const next = applyUiCommandToSplitLayout(layout, command, sourceSessionKey);
    if (next === layout) {
      return;
    }
    event.preventDefault();
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
      // Dividers and pane gaps sit between drop targets; keep the last preview
      // instead of flickering it away while the pointer crosses them.
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
    // Fall back to the retained preview when the drop lands on a divider or
    // gap, so the drop always matches what the indicator promised.
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

  // Route and active pane mirror each other: route changes land in the active
  // pane here, and pane-side changes call updateRoute. The equality guards on
  // both paths are what keep that from looping.
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

  private persistLayout(layout: ChatSplitLayout | undefined) {
    this.layout = layout;
    patchSettings({ chatSplitLayout: layout });
  }

  private updateRoute(sessionKey: string, replace = false) {
    if (this.data?.sessionKey === sessionKey) {
      return;
    }
    const options = { search: searchForSession(sessionKey) };
    if (replace) {
      this.context.replace("chat", options);
    } else {
      this.context.navigate("chat", options);
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
    sessionKey: string,
    options?: { replace?: boolean },
  ) => {
    const trimmed = sessionKey.trim();
    if (!trimmed) {
      return;
    }
    const layout = this.layout;
    if (!layout) {
      this.updateRoute(trimmed, options?.replace);
      return;
    }
    const pane = findPane(layout, paneId)?.pane;
    if (!pane || pane.sessionKey === trimmed) {
      return;
    }
    this.persistLayout(setPaneSession(layout, paneId, trimmed));
    if (layout.activePaneId === paneId) {
      this.updateRoute(trimmed, options?.replace);
    }
  };

  private readonly openSplitView = () => {
    const sessionKey = this.data?.sessionKey?.trim();
    if (sessionKey) {
      this.persistLayout(
        insertPane(this.classicLayout(sessionKey), this.classicPaneId, sessionKey, "right"),
      );
    }
  };

  private readonly handleSplitRight = (paneId: string) => {
    const layout = this.layout;
    const pane = layout ? findPane(layout, paneId)?.pane : null;
    if (!layout || !pane) {
      return;
    }
    this.persistLayout(insertPane(layout, paneId, pane.sessionKey, "right"));
  };

  private readonly handleSplitDown = (paneId: string) => {
    const layout = this.layout;
    const pane = layout ? findPane(layout, paneId)?.pane : null;
    if (!layout || !pane) {
      return;
    }
    this.persistLayout(insertPane(layout, paneId, pane.sessionKey, "down"));
  };

  private readonly handleClosePane = (paneId: string) => {
    const layout = this.layout;
    if (!layout) {
      return;
    }
    const survivingPane = panesOf(layout).find((pane) => pane.id !== paneId);
    const next = closePane(layout, paneId);
    if (!next && survivingPane) {
      const survivingLocation = findPane(layout, survivingPane.id);
      if (survivingLocation) {
        this.classicColumnId = survivingLocation.column.id;
        this.classicPaneId = survivingPane.id;
      }
    }
    this.persistLayout(next);
    if (!next && survivingPane) {
      this.updateRoute(survivingPane.sessionKey, true);
      return;
    }
    if (next) {
      const activePane = findPane(next, next.activePaneId)?.pane;
      if (activePane) {
        this.updateRoute(activePane.sessionKey, true);
      }
    }
  };

  // Route-owned face intent persists here, keyed exactly like chat-pane's
  // board settings, because pane-level board resolution is not ready at
  // navigation time and would file the face under the wrong session.
  private applyRouteFace(sessionKey: string, face: "dashboard"): void {
    const resolved = resolveSessionKey(sessionKey, this.context.gateway.snapshot.hello);
    const normalized = normalizeSessionKeyForUiComparison(resolved);
    const boardSessionKey =
      normalized === "main" ? buildAgentMainSessionKey({ agentId: "main" }) : normalized;
    if (!boardSessionKey) {
      return;
    }
    patchSettings({
      boardSessionViews: updateBoardSessionView(loadSettings().boardSessionViews, boardSessionKey, {
        face,
      }),
    });
  }

  private routeDraftForActivePane(sessionKey = this.data?.sessionKey): string | undefined {
    const data = this.data;
    // Route data can render before the split layout catches up. Never hand the
    // new route's draft to the previously active pane during that transition.
    if (!data || sessionKey !== data.sessionKey || this.consumedDraftData === data) {
      return undefined;
    }
    return data.draft;
  }

  /** Header + pane travel together so each pane owns its title bar in-flow —
   * no fixed toolbar layer mirroring the split geometry. The pane renders its
   * own header so the workspace toggle can read per-pane workspace state. */
  private renderPaneCell(
    pane: ChatSplitPane,
    active: boolean,
    weight: number,
    splitMode: boolean,
    ownerKey: string,
  ) {
    const sessions = this.context?.sessions?.state.result?.sessions ?? [];
    // Route keys can be unresolved aliases ("main"); resolve against the
    // hello defaults and match rows by equivalence like the pane itself
    // does, or renamed sessions fall back to the generic key-derived title.
    const resolvedKey =
      resolveSessionKey(pane.sessionKey, this.context?.gateway?.snapshot?.hello) || pane.sessionKey;
    const title = resolveSessionDisplayName(
      resolvedKey,
      sessions.find((row) => areUiSessionKeysEquivalent(row.key, resolvedKey)),
    );
    return html`
      <div
        class="chat-split-view__cell ${splitMode && active ? "chat-split-view__cell--active" : ""}"
        style="flex: ${weight} 1 0"
        @pointerdown=${() => this.handleFocusPane(pane.id)}
        @focusin=${() => this.handleFocusPane(pane.id)}
      >
        <openclaw-chat-pane
          class=${splitMode ? "chat-split-view__pane" : ""}
          data-mcp-app-owner-key=${ownerKey}
          .paneId=${pane.id}
          .chatMessagesBySession=${this.chatMessagesBySession}
          .sessionKey=${pane.sessionKey}
          .active=${active}
          .draft=${active ? this.routeDraftForActivePane(pane.sessionKey) : undefined}
          .paneTitle=${title}
          .narrow=${this.narrow}
          .mergedChrome=${this.mergedChrome && active}
          .onOpenSplitView=${splitMode || this.narrow ? undefined : this.openSplitView}
          .onSplitDown=${splitMode ? this.handleSplitDown : undefined}
          .onSplitRight=${splitMode ? this.handleSplitRight : undefined}
          .onClosePane=${splitMode ? this.handleClosePane : undefined}
          .onFocusPane=${this.handleFocusPane}
          .onPaneSessionChange=${this.handlePaneSessionChange}
        ></openclaw-chat-pane>
      </div>
    `;
  }

  private classicLayout(sessionKey = this.data?.sessionKey?.trim() ?? ""): ChatSplitLayout {
    return {
      columns: [
        {
          id: this.classicColumnId,
          panes: [{ id: this.classicPaneId, sessionKey }],
          paneWeights: [1],
        },
      ],
      columnWeights: [1],
      activePaneId: this.classicPaneId,
    };
  }

  private renderSplitLayout(layout: ChatSplitLayout, splitMode: boolean) {
    const activeLocation = findPane(layout, layout.activePaneId);
    const renderedColumns =
      this.narrow && activeLocation
        ? [
            {
              ...activeLocation.column,
              panes: [activeLocation.pane],
              paneWeights: [1],
            },
          ]
        : this.narrow
          ? []
          : layout.columns;
    const renderedColumnWeights = this.narrow ? [1] : layout.columnWeights;
    return html`
      <div class="chat-split-view ${this.narrow ? "chat-split-view--narrow" : ""}">
        ${repeat(
          renderedColumns,
          (column) => column.id,
          (column, columnIndex) => html`
            <div
              class="chat-split-view__column"
              style="flex: ${splitWeight(
                renderedColumnWeights,
                columnIndex,
                "rendered split column weight",
              )} 1 0"
            >
              ${repeat(
                column.panes,
                (pane) => pane.id,
                (pane, paneIndex) => html`
                  ${this.renderPaneCell(
                    pane,
                    pane.id === layout.activePaneId,
                    splitWeight(column.paneWeights, paneIndex, "rendered split pane weight"),
                    splitMode,
                    JSON.stringify([column.id, pane.id, pane.sessionKey]),
                  )}
                  ${paneIndex < column.panes.length - 1
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
            ${columnIndex < renderedColumns.length - 1
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
    const activeLocation = findPane(layout, layout.activePaneId);
    const renderedPaneOwners = this.narrow
      ? activeLocation
        ? [{ columnId: activeLocation.column.id, pane: activeLocation.pane }]
        : []
      : layout.columns.flatMap((column) =>
          column.panes.map((pane) => ({ columnId: column.id, pane })),
        );
    const nextPaneKeys = new Set(
      renderedPaneOwners.map(({ columnId, pane }) =>
        JSON.stringify([columnId, pane.id, pane.sessionKey]),
      ),
    );
    const rendered = html`
      <div class="chat-split-view__drop-container">
        ${this.renderSplitLayout(layout, Boolean(this.layout))}
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
