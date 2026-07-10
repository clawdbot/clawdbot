import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { icons } from "../../components/icons.ts";
import "../../components/resizable-divider.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { readSessionDragData, sessionDragActive } from "../../lib/sessions/drag.ts";
import { searchForSession } from "../../lib/sessions/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import "./chat-pane.ts";
import {
  resolveSplitDropZone,
  splitDropIndicatorRect,
  type SplitDropRect,
  type SplitDropZone,
} from "./split-drop-zone.ts";
import {
  closePane,
  createSinglePaneLayout,
  createSplitLayout,
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

type ChatRouteData = {
  sessionKey: string;
  draft?: string;
};

const NARROW_SPLIT_QUERY = "(max-width: 1099px)";

type DropIndicator = { paneId: string; zone: SplitDropZone; rect: SplitDropRect };
type ChatPaneElement = HTMLElement & { paneId?: string };

export class ChatPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;
  @property({ attribute: false }) data!: ChatRouteData;
  @state() private layout: ChatSplitLayout | undefined;
  @state() private narrow = false;
  @state() private dropIndicator: DropIndicator | null = null;

  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.sessions,
    (sessions, notify) => sessions.subscribe(notify),
  );
  private mediaQuery: MediaQueryList | null = null;
  // Light-DOM enter/leave events bubble from every nested child, so only clear
  // the shared preview after the whole balanced drag has left the page.
  private dragDepth = 0;
  private dragFrame = 0;
  private pendingDragOver: { pane: ChatPaneElement; x: number; y: number } | null = null;
  private consumedDraftData: ChatRouteData | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this.layout = loadSettings().chatSplitLayout;
    this.mediaQuery = window.matchMedia(NARROW_SPLIT_QUERY);
    this.narrow = this.mediaQuery.matches;
    this.mediaQuery.addEventListener("change", this.handleViewportChange);
    this.addEventListener("dragenter", this.handleDragEnter);
    this.addEventListener("dragover", this.handleDragOver);
    this.addEventListener("dragleave", this.handleDragLeave);
    this.addEventListener("drop", this.handleDrop);
    window.addEventListener("dragend", this.handleWindowDragEnd);
    this.syncRouteToActivePane();
  }

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.mediaQuery?.removeEventListener("change", this.handleViewportChange);
    this.mediaQuery = null;
    this.removeEventListener("dragenter", this.handleDragEnter);
    this.removeEventListener("dragover", this.handleDragOver);
    this.removeEventListener("dragleave", this.handleDragLeave);
    this.removeEventListener("drop", this.handleDrop);
    window.removeEventListener("dragend", this.handleWindowDragEnd);
    this.clearDropIndicator();
    super.disconnectedCallback();
  }

  override updated(changedProperties: Map<PropertyKey, unknown>) {
    const data = this.data;
    const activePane = this.layout ? findPane(this.layout, this.layout.activePaneId)?.pane : null;
    const routeDraftWasRendered =
      Boolean(data?.draft) &&
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
      const next = insertPane(createSinglePaneLayout(currentSessionKey), "p1", trimmed, zone.edge);
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
      this.persistLayout(createSplitLayout(sessionKey));
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
  private renderPaneCell(pane: ChatSplitPane, active: boolean, weight: number) {
    const sessions = this.context?.sessions?.state.result?.sessions ?? [];
    const title = resolveSessionDisplayName(
      pane.sessionKey,
      sessions.find((row) => row.key === pane.sessionKey),
    );
    return html`
      <div
        class="chat-split-view__cell ${active ? "chat-split-view__cell--active" : ""}"
        style="flex: ${weight} 1 0"
        @pointerdown=${() => this.handleFocusPane(pane.id)}
        @focusin=${() => this.handleFocusPane(pane.id)}
      >
        <openclaw-chat-pane
          class="chat-split-view__pane"
          .paneId=${pane.id}
          .sessionKey=${pane.sessionKey}
          .active=${active}
          .draft=${active ? this.routeDraftForActivePane(pane.sessionKey) : undefined}
          .showPaneHeader=${true}
          .paneTitle=${title}
          .narrow=${this.narrow}
          .onSplitDown=${this.handleSplitDown}
          .onSplitRight=${this.handleSplitRight}
          .onClosePane=${this.handleClosePane}
          .onFocusPane=${this.handleFocusPane}
          .onPaneSessionChange=${this.handlePaneSessionChange}
        ></openclaw-chat-pane>
      </div>
    `;
  }

  private renderSplitLayout(layout: ChatSplitLayout) {
    if (this.narrow) {
      const activePane = findPane(layout, layout.activePaneId)?.pane;
      return activePane
        ? html`<div class="chat-split-view chat-split-view--narrow">
            ${this.renderPaneCell(activePane, true, 1)}
          </div>`
        : nothing;
    }
    return html`
      <div class="chat-split-view">
        ${repeat(
          layout.columns,
          (column) => column.id,
          (column, columnIndex) => html`
            <div
              class="chat-split-view__column"
              style="flex: ${layout.columnWeights[columnIndex]} 1 0"
            >
              ${repeat(
                column.panes,
                (pane) => pane.id,
                (pane, paneIndex) => html`
                  ${this.renderPaneCell(
                    pane,
                    pane.id === layout.activePaneId,
                    column.paneWeights[paneIndex],
                  )}
                  ${paneIndex < column.panes.length - 1
                    ? html`
                        <resizable-divider
                          orientation="horizontal"
                          .splitRatio=${column.paneWeights[paneIndex] /
                          (column.paneWeights[paneIndex] + column.paneWeights[paneIndex + 1])}
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
            ${columnIndex < layout.columns.length - 1
              ? html`
                  <resizable-divider
                    .splitRatio=${layout.columnWeights[columnIndex] /
                    (layout.columnWeights[columnIndex] + layout.columnWeights[columnIndex + 1])}
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
    return html`
      <div class="chat-split-view__drop-container">
        ${this.layout
          ? this.renderSplitLayout(this.layout)
          : html`
              <openclaw-chat-pane
                .paneId=${"single"}
                .sessionKey=${this.data?.sessionKey ?? ""}
                .active=${true}
                .draft=${this.routeDraftForActivePane()}
                .showPaneHeader=${false}
                .onFocusPane=${this.handleFocusPane}
                .onPaneSessionChange=${this.handlePaneSessionChange}
              ></openclaw-chat-pane>
            `}
        ${!this.layout && !this.narrow
          ? html`
              <openclaw-tooltip .content=${t("chat.splitView.open")}>
                <button
                  class="btn btn--sm btn--icon chat-open-split-view"
                  type="button"
                  aria-label=${t("chat.splitView.open")}
                  @click=${this.openSplitView}
                >
                  ${icons.panelRightOpen}
                </button>
              </openclaw-tooltip>
            `
          : nothing}
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
  }
}

if (!customElements.get("openclaw-chat-page")) {
  customElements.define("openclaw-chat-page", ChatPage);
}
