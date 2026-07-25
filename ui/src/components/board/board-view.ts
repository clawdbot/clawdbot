import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { repeat } from "lit/directives/repeat.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import {
  BOARD_GRID_COLUMNS,
  BOARD_GRID_GAP,
  BOARD_GRID_ROW_HEIGHT,
  boardChromeRowPx,
  effectiveBoardWidgetRows,
  FINE_POINTER_QUERY,
  layout,
  nudge,
  previewDrag,
  resize,
  type BoardGridDirection,
  type BoardGridItem,
} from "../../lib/board/grid.ts";
import type { BoardOp, BoardTab } from "../../lib/board/types.ts";
import type {
  BoardGrantDecision,
  BoardObserverContext,
  BoardViewCallbacks,
  BoardViewSnapshot,
  BoardViewWidget,
  BoardWidgetFrameUrl,
} from "../../lib/board/view-types.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import "../../styles/board.css";
import "../web-awesome-tabs.ts";
import "../web-awesome.ts";
import type { BoardWidgetCellCallbacks } from "./board-widget-cell.ts";
import "./board-widget-cell.ts";

type BoardPointerGesture = {
  dropValid: boolean;
  mode: "move" | "resize";
  name: string;
  originClientX: number;
  originClientY: number;
  originW: number;
  originH: number;
  pointerId: number;
  items: BoardGridItem[];
};

function orderedTabs(snapshot: BoardViewSnapshot): BoardTab[] {
  return snapshot.tabs.toSorted(
    (left, right) => left.position - right.position || left.tabId.localeCompare(right.tabId),
  );
}

function orderedWidgets(snapshot: BoardViewSnapshot, tabId: string): BoardViewWidget[] {
  return snapshot.widgets
    .filter((widget) => widget.tabId === tabId)
    .toSorted(
      (left, right) => left.position - right.position || left.name.localeCompare(right.name),
    );
}

function itemsForWidgets(
  widgets: readonly BoardViewWidget[],
  contentHeights: ReadonlyMap<string, number>,
): BoardGridItem[] {
  const chromeRowPx = boardChromeRowPx();
  return widgets.map((widget) => ({
    name: widget.name,
    w: widget.sizeW,
    h: effectiveBoardWidgetRows(widget, contentHeights.get(widget.name), chromeRowPx),
    order: widget.position,
  }));
}

class OpenClawBoardView extends OpenClawLightDomElement {
  @property({ attribute: false }) snapshot?: BoardViewSnapshot;
  @property({ attribute: false }) activeTabId = "";
  @property({ attribute: false }) widgetFrameUrl?: BoardWidgetFrameUrl;
  @property({ attribute: false }) callbacks?: BoardViewCallbacks;
  @property({ attribute: false }) sessions: readonly GatewaySessionRow[] = [];
  @property({ attribute: false }) observer?: BoardObserverContext;
  @property({ type: Boolean }) canMutate = true;
  @property({ type: Boolean }) canGrant = true;

  @state() private previewItems: BoardGridItem[] | null = null;
  @state() private gestureName = "";
  @state() private hoverTabId = "";
  @state() private announcement = "";
  @state() private announcementRevision = 0;
  @state() private actionError = "";
  @state() private focusName = "";
  @state() private mutationPending = false;

  private gesture: BoardPointerGesture | null = null;
  private mutationRequestId = 0;
  private stableCellOrder = new Map<string, number>();
  private stableCellOrderSequence = 0;
  private readonly contentHeights = new Map<string, number>();
  // Hybrid devices flip pointer capability live (mouse dock/undock); CSS moves
  // the bar between overlay and in-flow, so auto-height rows must re-layout.
  private readonly finePointerQuery =
    typeof window.matchMedia === "function" ? window.matchMedia(FINE_POINTER_QUERY) : null;
  private readonly handlePointerModeChange = () => this.requestUpdate();

  override connectedCallback(): void {
    super.connectedCallback();
    this.finePointerQuery?.addEventListener("change", this.handlePointerModeChange);
  }

  override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("snapshot")) {
      this.actionError = "";
      const previousSnapshot = changed.get("snapshot");
      if (previousSnapshot?.sessionKey !== this.snapshot?.sessionKey) {
        this.mutationRequestId += 1;
        this.mutationPending = false;
        this.focusName = "";
        this.stableCellOrder.clear();
        this.stableCellOrderSequence = 0;
        this.contentHeights.clear();
      } else if (previousSnapshot && this.snapshot) {
        const previousByName = new Map(
          previousSnapshot.widgets.map((widget) => [widget.name, widget]),
        );
        for (const name of this.contentHeights.keys()) {
          const previous = previousByName.get(name);
          const current = this.snapshot.widgets.find((widget) => widget.name === name);
          if (
            !current ||
            current.contentKind !== "html" ||
            previous?.revision !== current.revision
          ) {
            this.contentHeights.delete(name);
          }
        }
      }
    }
    if (changed.has("activeTabId")) {
      this.focusName = "";
    }
    if (this.gesture && (changed.has("snapshot") || changed.has("activeTabId"))) {
      this.cancelGesture();
    }
  }

  override disconnectedCallback(): void {
    this.finePointerQuery?.removeEventListener("change", this.handlePointerModeChange);
    this.cancelGesture();
    super.disconnectedCallback();
  }

  private activeTab(tabs: readonly BoardTab[]): BoardTab | undefined {
    return tabs.find((tab) => tab.tabId === this.activeTabId) ?? tabs[0];
  }

  private announce(message: string): void {
    this.announcement = message;
    this.announcementRevision += 1;
  }

  private async applyOps(ops: BoardOp[], announcement: string): Promise<void> {
    if (!this.callbacks) {
      return;
    }
    if (this.mutationPending) {
      throw new Error(t("board.actionInProgress"));
    }
    const sessionKey = this.snapshot?.sessionKey;
    const requestId = this.mutationRequestId + 1;
    this.mutationRequestId = requestId;
    this.mutationPending = true;
    this.actionError = "";
    try {
      await this.callbacks.applyOps(ops);
      if (requestId === this.mutationRequestId && sessionKey === this.snapshot?.sessionKey) {
        this.announce(announcement);
      }
    } catch (error) {
      if (requestId === this.mutationRequestId && sessionKey === this.snapshot?.sessionKey) {
        this.actionError = t("board.actionFailed");
        this.announce(this.actionError);
      }
      throw error;
    } finally {
      if (requestId === this.mutationRequestId) {
        this.mutationPending = false;
      }
    }
  }

  private nextPosition(tabId: string): number {
    const positions = this.snapshot?.widgets
      .filter((widget) => widget.tabId === tabId)
      .map((widget) => widget.position) ?? [0];
    return Math.max(-1, ...positions) + 1;
  }

  private readonly cellCallbacks: BoardWidgetCellCallbacks = {
    grant: async (name: string, decision: BoardGrantDecision) => {
      if (!this.callbacks) {
        return;
      }
      const sessionKey = this.snapshot?.sessionKey;
      await this.callbacks.grant(name, decision);
      if (sessionKey === this.snapshot?.sessionKey) {
        this.announce(
          decision === "granted"
            ? t("board.announcement.granted")
            : t("board.announcement.rejected"),
        );
      }
    },
    movePointerDown: (widget, event) => this.beginGesture("move", widget, event),
    resizePointerDown: (widget, event) => this.beginGesture("resize", widget, event),
    moveToTab: async (widget, tabId) => {
      await this.applyOps(
        [
          {
            kind: "widget_move",
            name: widget.name,
            tabId,
            position: this.nextPosition(tabId),
          },
        ],
        t("board.announcement.moved", { title: widget.title || widget.name }),
      );
    },
    resizeTo: async (widget, w, h) => {
      await this.applyOps(
        [{ kind: "widget_resize", name: widget.name, sizeW: w, sizeH: h, heightMode: "fixed" }],
        t("board.announcement.resized", { title: widget.title || widget.name }),
      );
    },
    setHeightMode: async (widget, mode) => {
      // Pinning keeps the currently rendered auto height, not the stale stored
      // sizeH, so "fixed" freezes exactly what the user sees.
      const sizeH =
        mode === "fixed"
          ? effectiveBoardWidgetRows(
              widget,
              this.contentHeights.get(widget.name),
              boardChromeRowPx(),
            )
          : widget.sizeH;
      await this.applyOps(
        [
          {
            kind: "widget_resize",
            name: widget.name,
            sizeW: widget.sizeW,
            sizeH,
            heightMode: mode,
          },
        ],
        t("board.announcement.resized", { title: widget.title || widget.name }),
      );
    },
    reportContentHeight: (name, height) => {
      const widget = this.snapshot?.widgets.find((candidate) => candidate.name === name);
      if (!widget || widget.contentKind !== "html") {
        return;
      }
      const chromeRowPx = boardChromeRowPx();
      const previousRows = effectiveBoardWidgetRows(
        widget,
        this.contentHeights.get(name),
        chromeRowPx,
      );
      this.contentHeights.set(name, height);
      if (effectiveBoardWidgetRows(widget, height, chromeRowPx) !== previousRows) {
        this.requestUpdate();
      }
    },
    remove: async (widget) => {
      await this.applyOps(
        [{ kind: "widget_remove", name: widget.name }],
        t("board.announcement.removed", { title: widget.title || widget.name }),
      );
    },
    nudge: async (widget, direction) => this.nudgeWidget(widget, direction),
    focus: (widget, direction) => this.focusWidget(widget, direction),
    focusChanged: (name) => {
      this.focusName = name;
    },
    frameLoadFailed: async (name) => {
      await this.callbacks?.frameLoadFailed?.(name);
    },
    widgetAppView: async (name, revision) =>
      (await this.callbacks?.widgetAppView?.(name, revision)) ?? {
        status: "stale",
        error: "MCP App view unavailable",
      },
    refreshWidgetAppView: async (name, revision) =>
      (await this.callbacks?.refreshWidgetAppView?.(name, revision)) ?? {
        status: "stale",
        error: "MCP App view unavailable",
      },
  };

  private beginGesture(
    mode: BoardPointerGesture["mode"],
    widget: BoardViewWidget,
    event: PointerEvent,
  ): void {
    if (!this.canMutate || event.button !== 0 || this.gesture || this.mutationPending) {
      return;
    }
    const snapshot = this.snapshot;
    const tabs = snapshot ? orderedTabs(snapshot) : [];
    const tab = this.activeTab(tabs);
    if (!snapshot || !tab) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    try {
      (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic pointers and detached test targets cannot be captured.
    }
    const items = itemsForWidgets(orderedWidgets(snapshot, tab.tabId), this.contentHeights);
    this.gesture = {
      dropValid: false,
      mode,
      name: widget.name,
      originClientX: event.clientX,
      originClientY: event.clientY,
      originW: widget.sizeW,
      originH: effectiveBoardWidgetRows(
        widget,
        this.contentHeights.get(widget.name),
        boardChromeRowPx(),
      ),
      pointerId: event.pointerId,
      items,
    };
    this.previewItems = items;
    this.gestureName = widget.name;
    window.addEventListener("pointermove", this.handlePointerMove);
    window.addEventListener("pointerup", this.handlePointerUp);
    window.addEventListener("pointercancel", this.handlePointerCancel);
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) {
      return;
    }
    if (gesture.mode === "move") {
      const tabTarget = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-board-tab-id]");
      const candidateTabId =
        tabTarget?.closest("openclaw-board-view") === this
          ? (tabTarget.dataset.boardTabId ?? "")
          : "";
      const candidateIsValid =
        candidateTabId !== "" &&
        (this.snapshot?.tabs.some((tab) => tab.tabId === candidateTabId) ?? false);
      const currentTabId = this.snapshot
        ? this.activeTab(orderedTabs(this.snapshot))?.tabId
        : this.activeTabId;
      this.hoverTabId = candidateIsValid && candidateTabId !== currentTabId ? candidateTabId : "";
      if (tabTarget) {
        this.previewItems = gesture.items;
        gesture.dropValid = this.hoverTabId !== "";
        return;
      }
      const grid = this.querySelector<HTMLElement>(".board-grid");
      const pointerElement = document.elementFromPoint(event.clientX, event.clientY);
      if (!grid || pointerElement?.closest(".board-grid") !== grid) {
        this.hoverTabId = "";
        this.previewItems = gesture.items;
        gesture.dropValid = false;
        return;
      }
      gesture.dropValid = true;
      const bounds = grid.getBoundingClientRect();
      const columnWidth = Math.max(
        1,
        (bounds.width - BOARD_GRID_GAP * (BOARD_GRID_COLUMNS - 1)) / BOARD_GRID_COLUMNS,
      );
      const targetCell = {
        x: Math.floor((event.clientX - bounds.left) / (columnWidth + BOARD_GRID_GAP)),
        y: Math.floor((event.clientY - bounds.top) / (BOARD_GRID_ROW_HEIGHT + BOARD_GRID_GAP)),
      };
      this.previewItems = previewDrag(gesture.items, gesture.name, targetCell).items;
      return;
    }

    const grid = this.querySelector<HTMLElement>(".board-grid");
    const bounds = grid?.getBoundingClientRect();
    const columnWidth = bounds
      ? Math.max(1, (bounds.width - BOARD_GRID_GAP * (BOARD_GRID_COLUMNS - 1)) / BOARD_GRID_COLUMNS)
      : BOARD_GRID_ROW_HEIGHT;
    const deltaW = Math.round(
      (event.clientX - gesture.originClientX) / (columnWidth + BOARD_GRID_GAP),
    );
    const deltaH = Math.round(
      (event.clientY - gesture.originClientY) / (BOARD_GRID_ROW_HEIGHT + BOARD_GRID_GAP),
    );
    this.previewItems = resize(
      gesture.items,
      gesture.name,
      gesture.originW + deltaW,
      gesture.originH + deltaH,
    );
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) {
      return;
    }
    this.handlePointerMove(event);
    const previewItems = this.previewItems;
    const hoverTabId = this.hoverTabId;
    this.cancelGesture();
    const widget = this.snapshot?.widgets.find((entry) => entry.name === gesture.name);
    if (!widget) {
      return;
    }
    if (gesture.mode === "move") {
      if (!gesture.dropValid) {
        return;
      }
      const position = hoverTabId
        ? this.nextPosition(hoverTabId)
        : (previewItems?.find((item) => item.name === gesture.name)?.order ?? widget.position);
      if (!hoverTabId && position === widget.position) {
        return;
      }
      void this.applyOps(
        [
          {
            kind: "widget_move",
            name: gesture.name,
            ...(hoverTabId ? { tabId: hoverTabId } : {}),
            position,
          },
        ],
        t("board.announcement.moved", { title: widget.title || widget.name }),
      ).catch(() => undefined);
      return;
    }
    const resized = previewItems?.find((item) => item.name === gesture.name);
    if (resized && (resized.w !== gesture.originW || resized.h !== gesture.originH)) {
      void this.applyOps(
        [
          {
            kind: "widget_resize",
            name: gesture.name,
            sizeW: resized.w,
            sizeH: resized.h,
            heightMode: "fixed",
          },
        ],
        t("board.announcement.resized", { title: widget.title || widget.name }),
      ).catch(() => undefined);
    }
  };

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    if (this.gesture && event.pointerId === this.gesture.pointerId) {
      this.cancelGesture();
    }
  };

  private cancelGesture(): void {
    window.removeEventListener("pointermove", this.handlePointerMove);
    window.removeEventListener("pointerup", this.handlePointerUp);
    window.removeEventListener("pointercancel", this.handlePointerCancel);
    this.gesture = null;
    this.previewItems = null;
    this.gestureName = "";
    this.hoverTabId = "";
  }

  private async nudgeWidget(widget: BoardViewWidget, direction: BoardGridDirection): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return;
    }
    const items = itemsForWidgets(orderedWidgets(snapshot, widget.tabId), this.contentHeights);
    const moved = nudge(items, widget.name, direction).find((item) => item.name === widget.name);
    if (!moved || moved.order === widget.position) {
      return;
    }
    await this.applyOps(
      [{ kind: "widget_move", name: widget.name, position: moved.order }],
      t("board.announcement.moved", { title: widget.title || widget.name }),
    );
  }

  private focusWidget(widget: BoardViewWidget, direction: BoardGridDirection): void {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return;
    }
    const widgets = orderedWidgets(snapshot, widget.tabId);
    const index = widgets.findIndex((entry) => entry.name === widget.name);
    if (index < 0) {
      return;
    }
    const offset = direction === "left" || direction === "up" ? -1 : 1;
    const target = widgets[Math.max(0, Math.min(index + offset, widgets.length - 1))];
    if (!target || target.name === widget.name) {
      return;
    }
    this.focusName = target.name;
    void this.updateComplete.then(() => {
      const cell = [...this.querySelectorAll("openclaw-board-widget-cell")].find(
        (entry) => entry.widget?.name === target.name,
      );
      cell?.querySelector<HTMLElement>(".board-widget")?.focus();
    });
  }

  private readonly handleTabShow = (event: CustomEvent<{ name: string }>): void => {
    const tabs = this.snapshot ? orderedTabs(this.snapshot) : [];
    const currentTabId = this.activeTab(tabs)?.tabId ?? this.activeTabId;
    if (event.detail.name !== currentTabId && tabs.some((tab) => tab.tabId === event.detail.name)) {
      this.callbacks?.selectTab(event.detail.name);
    }
  };

  private readonly handleOverflowSelect = (
    event: CustomEvent<{ item: { value?: string } }>,
  ): void => {
    const tabId = event.detail.item.value;
    if (tabId && this.snapshot?.tabs.some((tab) => tab.tabId === tabId)) {
      this.callbacks?.selectTab(tabId);
    }
  };

  private renderTab(tab: BoardTab, activeTabId: string): TemplateResult {
    const active = tab.tabId === activeTabId;
    const dropTarget = tab.tabId === this.hoverTabId;
    return html`
      <wa-tab
        class=${`board-tabs__tab ${active ? "board-tabs__tab--active" : ""} ${dropTarget ? "board-tabs__tab--drop" : ""}`}
        panel=${tab.tabId}
        ?active=${active}
        data-board-tab-id=${tab.tabId}
      >
        ${tab.title}
      </wa-tab>
    `;
  }

  private renderOverflowTab(tab: BoardTab): TemplateResult {
    return html`
      <wa-dropdown-item
        class="board-tabs__overflow-item"
        value=${tab.tabId}
        data-board-tab-id=${tab.tabId}
      >
        ${tab.title}
      </wa-dropdown-item>
    `;
  }

  private renderTabs(
    tabs: readonly BoardTab[],
    activeTabId: string,
  ): TemplateResult | typeof nothing {
    if (tabs.length <= 1) {
      return nothing;
    }
    const visible = tabs.slice(0, 6);
    const active = tabs.find((tab) => tab.tabId === activeTabId);
    if (active && !visible.some((tab) => tab.tabId === active.tabId)) {
      visible[visible.length - 1] = active;
    }
    const visibleIds = new Set(visible.map((tab) => tab.tabId));
    const overflow = tabs.filter((tab) => !visibleIds.has(tab.tabId));
    return html`
      <nav class="board-tabs" aria-label=${t("board.tabsLabel")}>
        <wa-tab-group
          class="board-tabs__track"
          .active=${activeTabId}
          activation="manual"
          without-scroll-controls
          @wa-tab-show=${this.handleTabShow}
        >
          ${visible.map((tab) => this.renderTab(tab, activeTabId))}
        </wa-tab-group>
        ${overflow.length > 0
          ? html`
              <wa-dropdown
                class="board-tabs__overflow"
                placement="bottom-end"
                @wa-select=${this.handleOverflowSelect}
              >
                <button
                  class="board-tabs__overflow-trigger"
                  slot="trigger"
                  type="button"
                  aria-label=${t("board.moreTabs")}
                  title=${t("board.moreTabs")}
                >
                  •••
                </button>
                ${overflow.map((tab) => this.renderOverflowTab(tab))}
              </wa-dropdown>
            `
          : nothing}
      </nav>
    `;
  }

  private renderGrid(
    widgets: readonly BoardViewWidget[],
    tabs: readonly BoardTab[],
    sessionKey: string,
  ): TemplateResult {
    if (widgets.length === 0) {
      return html`
        <div class="board-empty" data-test-id="board-empty">
          <span class="board-empty__mark" aria-hidden="true">＋</span>
          <strong>${t("board.emptyTitle")}</strong>
          <span>${t("board.emptyHint")}</span>
        </div>
      `;
    }
    const items = this.previewItems ?? itemsForWidgets(widgets, this.contentHeights);
    const rects = layout(items);
    for (const rect of rects) {
      if (!this.stableCellOrder.has(rect.name)) {
        this.stableCellOrder.set(rect.name, this.stableCellOrderSequence);
        this.stableCellOrderSequence += 1;
      }
    }
    const stableRects = rects.toSorted(
      (left, right) =>
        (this.stableCellOrder.get(left.name) ?? 0) - (this.stableCellOrder.get(right.name) ?? 0) ||
        left.name.localeCompare(right.name),
    );
    const logicalPosition = new Map(rects.map((rect, index) => [rect.name, index]));
    const focusName = rects.some((rect) => rect.name === this.focusName)
      ? this.focusName
      : (rects[0]?.name ?? "");
    const widgetByName = new Map(widgets.map((widget) => [widget.name, widget]));
    return html`
      <div class="board-grid" role="list" aria-label=${t("board.gridLabel")}>
        ${repeat(
          stableRects,
          (rect) => `${sessionKey}\u0000${rect.name}`,
          (rect) => {
            const widget = widgetByName.get(rect.name);
            if (!widget) {
              return nothing;
            }
            return html`
              <openclaw-board-widget-cell
                .widget=${widget}
                .rect=${rect}
                .tabs=${tabs}
                .sessionKey=${sessionKey}
                .widgetFrameUrl=${this.widgetFrameUrl}
                .callbacks=${this.cellCallbacks}
                .sessions=${this.sessions}
                .observer=${this.observer}
                .dragging=${widget.name === this.gestureName}
                .focusTabIndex=${widget.name === focusName ? 0 : -1}
                .positionInSet=${(logicalPosition.get(widget.name) ?? 0) + 1}
                .setSize=${rects.length}
                .busy=${this.mutationPending}
                .canMutate=${this.canMutate}
                .canGrant=${this.canGrant}
              ></openclaw-board-widget-cell>
            `;
          },
        )}
        ${this.gesture?.mode === "move"
          ? html`<div class="board-grid__append-zone" aria-hidden="true"></div>`
          : nothing}
      </div>
    `;
  }

  override render() {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return nothing;
    }
    const tabs = orderedTabs(snapshot);
    const activeTab = this.activeTab(tabs);
    const activeTabId = activeTab?.tabId ?? this.activeTabId;
    const widgets = activeTab ? orderedWidgets(snapshot, activeTab.tabId) : [];
    return html`
      <section class="board-view" aria-label=${t("board.label")}>
        ${this.renderTabs(tabs, activeTabId)} ${this.renderGrid(widgets, tabs, snapshot.sessionKey)}
        ${this.actionError
          ? html`<div class="board-view__error" role="alert">${this.actionError}</div>`
          : nothing}
        <div class="board-announcer" aria-live="polite" aria-atomic="true">
          ${this.announcement
            ? keyed(
                this.announcementRevision,
                html`<span data-announcement-revision=${this.announcementRevision}
                  >${this.announcement}</span
                >`,
              )
            : nothing}
        </div>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-board-view")) {
  customElements.define("openclaw-board-view", OpenClawBoardView);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-board-view": OpenClawBoardView;
  }
}
