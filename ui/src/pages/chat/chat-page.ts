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
  // Horizontal scroll offset of .chat-split-view when its columns overflow;
  // the fixed toolbar track mirrors it so segments stay over their panes.
  @state() private splitScrollLeft = 0;

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
    if (changedProperties.has("data")) {
      this.syncRouteToActivePane();
    }
  }

  private readonly handleViewportChange = (event: MediaQueryListEvent) => {
    this.narrow = event.matches;
    // Mode flips remount .chat-split-view with scrollLeft 0 and no scroll
    // event; drop the mirrored offset so the toolbar track is not left shifted.
    this.splitScrollLeft = 0;
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
      this.splitScrollLeft = 0;
      this.persistLayout(createSplitLayout(sessionKey));
    }
  };

  private readonly handleSplitViewScroll = (event: Event) => {
    const left = (event.currentTarget as HTMLElement).scrollLeft;
    if (left !== this.splitScrollLeft) {
      this.splitScrollLeft = left;
    }
  };

  private readonly handleToolbarPaneFocus = (paneId: string) => {
    this.handleFocusPane(paneId);
    // Tabbing can land on a toolbar segment the clipped track has translated
    // off-screen; scroll its pane into view so the scroll sync follows and the
    // focused control becomes visible (no-op when already in view).
    const pane = Array.from(this.querySelectorAll<ChatPaneElement>("openclaw-chat-pane")).find(
      (element) => element.paneId === paneId,
    );
    pane?.scrollIntoView({ block: "nearest", inline: "nearest" });
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

  private renderPane(pane: ChatSplitPane, active: boolean, weight: number) {
    return html`
      <openclaw-chat-pane
        class="chat-split-view__pane ${active ? "chat-split-view__pane--active" : ""}"
        style="flex: ${weight} 1 0"
        .paneId=${pane.id}
        .sessionKey=${pane.sessionKey}
        .active=${active}
        .draft=${active ? this.data?.draft : undefined}
        .onFocusPane=${this.handleFocusPane}
        .onPaneSessionChange=${this.handlePaneSessionChange}
      ></openclaw-chat-pane>
    `;
  }

  private renderSplitToolbarPane(layout: ChatSplitLayout, pane: ChatSplitPane) {
    const sessions = this.context?.sessions?.state.result?.sessions ?? [];
    const active = pane.id === layout.activePaneId;
    const title = resolveSessionDisplayName(
      pane.sessionKey,
      sessions.find((row) => row.key === pane.sessionKey),
    );
    return html`
      <div
        class="chat-split-toolbar__pane ${active ? "chat-split-toolbar__pane--active" : ""}"
        @pointerdown=${() => this.handleFocusPane(pane.id)}
        @focusin=${() => this.handleToolbarPaneFocus(pane.id)}
      >
        <!-- Static text on purpose: this strip doubles as the Mac app titlebar
             drag area, and an interactive session picker here swallows window
             drags. Panes change sessions via the sidebar or drag-and-drop. -->
        <span class="chat-pane__session-title" title=${title}>${title}</span>
        <div class="chat-pane__actions">
          ${!this.narrow
            ? html`
                <openclaw-tooltip .content=${t("chat.splitView.splitDown")}>
                  <button
                    class="btn btn--ghost btn--icon"
                    type="button"
                    aria-label=${t("chat.splitView.splitDown")}
                    @click=${() => this.handleSplitDown(pane.id)}
                  >
                    ${icons.panelBottomOpen}
                  </button>
                </openclaw-tooltip>
                <openclaw-tooltip .content=${t("chat.splitView.splitRight")}>
                  <button
                    class="btn btn--ghost btn--icon"
                    type="button"
                    aria-label=${t("chat.splitView.splitRight")}
                    @click=${() => this.handleSplitRight(pane.id)}
                  >
                    ${icons.panelRightOpen}
                  </button>
                </openclaw-tooltip>
              `
            : nothing}
          <openclaw-tooltip .content=${t("chat.splitView.closePane")}>
            <button
              class="btn btn--ghost btn--icon"
              type="button"
              aria-label=${t("chat.splitView.closePane")}
              @click=${() => this.handleClosePane(pane.id)}
            >
              ${icons.x}
            </button>
          </openclaw-tooltip>
        </div>
      </div>
    `;
  }

  private renderSplitToolbar(layout: ChatSplitLayout) {
    if (this.narrow) {
      const activePane = findPane(layout, layout.activePaneId)?.pane;
      return html`
        <div class="chat-split-toolbar">
          ${activePane ? this.renderSplitToolbarPane(layout, activePane) : nothing}
        </div>
      `;
    }
    // Mirror the split view's flex geometry (same column weights, 4px gaps at
    // divider positions, same container bounds) so header segment edges land
    // exactly on the pane edges below; the track follows the split view's
    // horizontal scroll when columns overflow. See split-view.css.
    return html`
      <div class="chat-split-toolbar">
        <div
          class="chat-split-toolbar__track"
          style=${this.splitScrollLeft ? `transform: translateX(${-this.splitScrollLeft}px)` : ""}
        >
          ${layout.columns.map(
            (column, columnIndex) => html`
              ${columnIndex > 0 ? html`<div class="chat-split-toolbar__gap"></div>` : nothing}
              <div
                class="chat-split-toolbar__column"
                style="flex: ${layout.columnWeights[columnIndex]} 1 0"
              >
                ${column.panes.map((pane) => this.renderSplitToolbarPane(layout, pane))}
              </div>
            `,
          )}
        </div>
      </div>
    `;
  }

  private renderSplitLayout(layout: ChatSplitLayout) {
    if (this.narrow) {
      const activePane = findPane(layout, layout.activePaneId)?.pane;
      return activePane
        ? html`<div class="chat-split-view chat-split-view--narrow">
            ${this.renderPane(activePane, true, 1)}
          </div>`
        : nothing;
    }
    return html`
      <div class="chat-split-view" @scroll=${this.handleSplitViewScroll}>
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
                  ${this.renderPane(
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
        ${this.layout ? this.renderSplitToolbar(this.layout) : nothing}
        ${this.layout
          ? this.renderSplitLayout(this.layout)
          : html`
              <openclaw-chat-pane
                .paneId=${"single"}
                .sessionKey=${this.data?.sessionKey ?? ""}
                .active=${true}
                .draft=${this.data?.draft}
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
