import { html, nothing, render as renderTemplate } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";
import { icons } from "../../../components/icons.ts";
import "../../../components/web-awesome-tabs.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import {
  SIDEBAR_MIN_WIDTH_PX,
  isSidebarRegionCollapsed,
  type SidebarColumn,
  type SidebarLayout,
  type SidebarPanel,
  type SidebarSide,
  type SidebarSlotId,
} from "../sidebar-layout.ts";
import { resolveSplitDropZone } from "../split-drop-zone.ts";
import { renderChatResizableDivider } from "./chat-resizable-divider.ts";
import type { SidebarPanelTemplates, SidebarRegionCallbacks } from "./chat-sidebar-region-types.ts";
import "./chat-sidebar.ts";
import "./session-discussion-panel.ts";

function panelTitle(slot: SidebarSlotId): string {
  if (slot === "chat") {
    return t("chat.sidebarColumns.chat");
  }
  if (slot === "discussion") {
    return t("chat.sidebarColumns.discussion");
  }
  return t("chat.sidebarColumns.detail");
}

function panelsOf(layout: SidebarLayout): SidebarPanel[] {
  return layout.columns.flatMap((column) => column.panels);
}

class ChatSidebarRegion extends OpenClawLightDomElement {
  @property({ attribute: false }) layout: SidebarLayout = { columns: [] };
  @property({ attribute: false }) panelTemplates: SidebarPanelTemplates = {};
  @property({ attribute: false }) panelOpenUrls: Partial<Record<SidebarSlotId, string | null>> = {};
  @property({ attribute: false }) panelMutationEnabled: Partial<Record<SidebarSlotId, boolean>> =
    {};
  @property({ attribute: false }) callbacks: SidebarRegionCallbacks | null = null;
  @property() sessionKey = "";
  @property() focusPanelId = "";
  @property({ type: Number }) focusVersion = 0;
  @property({ type: Boolean }) narrow = false;
  @property({ type: Number }) availableWidth = 0;

  @state() private draggedPanelId = "";

  private startDrag(event: DragEvent, panelId: string) {
    this.draggedPanelId = panelId;
    event.dataTransfer?.setData("application/x-openclaw-sidebar-panel", panelId);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
    }
  }

  private endDrag() {
    this.draggedPanelId = "";
  }

  private draggedPanel(): SidebarPanel | undefined {
    const panel = panelsOf(this.layout).find((candidate) => candidate.id === this.draggedPanelId);
    return panel && this.canMutatePanel(panel.slot) ? panel : undefined;
  }

  private allowPanelDrop(event: DragEvent) {
    if (!this.draggedPanel()) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
  }

  private dropOnHeader(event: DragEvent, column: SidebarColumn) {
    const draggedPanel = this.draggedPanel();
    if (!draggedPanel) {
      return;
    }
    event.preventDefault();
    const tab = event
      .composedPath()
      .find(
        (target): target is HTMLElement =>
          target instanceof HTMLElement && target.classList.contains("sidebar-column__tab"),
      );
    const targetPanelId = tab?.dataset.panelId;
    let panelIndex = column.panels.length;
    if (targetPanelId && tab) {
      const targetIndex = column.panels.findIndex((panel) => panel.id === targetPanelId);
      const rect = tab.getBoundingClientRect();
      const zone = resolveSplitDropZone(rect, event.clientX, event.clientY);
      panelIndex = targetIndex + (zone.kind === "edge" && zone.edge === "left" ? 0 : 1);
    }
    this.callbacks?.mergePanel(draggedPanel.id, column.id, panelIndex);
    this.endDrag();
  }

  private dropOnBoundary(
    event: DragEvent,
    side: SidebarSide,
    columnIndex: number,
    element: Element | undefined,
  ) {
    const panel = this.draggedPanel();
    if (!panel || !(element instanceof HTMLElement)) {
      return;
    }
    const rect = element.getBoundingClientRect();
    const zone = resolveSplitDropZone(rect, event.clientX, event.clientY);
    if (zone.kind !== "edge" || (zone.edge !== "left" && zone.edge !== "right")) {
      return;
    }
    event.preventDefault();
    this.callbacks?.detachPanel(panel.id, side, columnIndex);
    this.endDrag();
  }

  private activate(panelId: string) {
    this.callbacks?.activatePanel(panelId);
  }

  private canMutatePanel(slot: SidebarSlotId): boolean {
    return this.panelMutationEnabled[slot] !== false;
  }

  private renderEmptySideDropZone(side: SidebarSide) {
    const panel = this.draggedPanel();
    if (!panel || this.layout.columns.some((column) => column.side === side)) {
      return nothing;
    }
    const label = t(
      side === "left"
        ? "chat.sidebarColumns.dropOnEmptyLeft"
        : "chat.sidebarColumns.dropOnEmptyRight",
      { panel: panelTitle(panel.slot) },
    );
    return html`<div
      class="sidebar-empty-side-drop-zone sidebar-empty-side-drop-zone--${side}"
      role="region"
      aria-label=${label}
      @dragover=${(event: DragEvent) => this.allowPanelDrop(event)}
      @drop=${(event: DragEvent) =>
        this.dropOnBoundary(
          event,
          side,
          0,
          (event.currentTarget as HTMLElement).querySelector(
            ".sidebar-empty-side-drop-zone__boundary",
          ) ?? undefined,
        )}
    >
      <span class="sidebar-empty-side-drop-zone__boundary" aria-hidden="true"></span>
    </div>`;
  }

  private renderHeader(column: SidebarColumn, activePanelId: string, narrow: boolean) {
    const active = column.panels.find((panel) => panel.id === activePanelId) ?? column.panels[0];
    if (!active) {
      return nothing;
    }
    const openUrl = this.panelOpenUrls[active.slot];
    const singlePanel = column.panels.length === 1 ? active : null;
    const singlePanelDraggable =
      singlePanel != null && !narrow && this.canMutatePanel(singlePanel.slot);
    return html`
      <div
        class="rail-header sidebar-column__header"
        @dragover=${(event: DragEvent) => (narrow ? undefined : this.allowPanelDrop(event))}
        @drop=${(event: DragEvent) => (narrow ? undefined : this.dropOnHeader(event, column))}
      >
        ${singlePanel
          ? html`<div
              class="rail-header__copy sidebar-column__single-panel sidebar-column__tab"
              data-panel-id=${singlePanel.id}
              .draggable=${singlePanelDraggable}
              title=${singlePanelDraggable
                ? t("chat.sidebarColumns.drag", { panel: panelTitle(singlePanel.slot) })
                : nothing}
              @dragstart=${(event: DragEvent) =>
                singlePanelDraggable ? this.startDrag(event, singlePanel.id) : undefined}
              @dragend=${() => this.endDrag()}
            >
              <strong class="rail-header__title">${panelTitle(singlePanel.slot)}</strong>
            </div>`
          : html`<wa-tab-group
              class="sidebar-column__tabs"
              .active=${active.id}
              activation="auto"
              without-scroll-controls
              @wa-tab-show=${(event: CustomEvent<{ name: string }>) =>
                this.activate(event.detail.name)}
            >
              ${column.panels.map((panel) => {
                const draggable = !narrow && this.canMutatePanel(panel.slot);
                return html`
                  <wa-tab
                    class="sidebar-column__tab"
                    panel=${panel.id}
                    data-panel-id=${panel.id}
                    .draggable=${draggable}
                    title=${draggable
                      ? t("chat.sidebarColumns.drag", { panel: panelTitle(panel.slot) })
                      : nothing}
                    @dragstart=${(event: DragEvent) =>
                      draggable ? this.startDrag(event, panel.id) : undefined}
                    @dragend=${() => this.endDrag()}
                  >
                    ${panelTitle(panel.slot)}
                  </wa-tab>
                `;
              })}
            </wa-tab-group>`}
        <div class="rail-header__actions sidebar-column__actions">
          ${openUrl
            ? html`<a
                class="rail-header__action"
                href=${openUrl}
                target="_blank"
                rel="noopener"
                aria-label=${t("chat.sessionDiscussion.openExternal")}
                title=${t("chat.sessionDiscussion.openExternal")}
                >${icons.externalLink}</a
              >`
            : nothing}
          ${this.canMutatePanel(active.slot)
            ? html`<button
                class="rail-header__action"
                type="button"
                aria-label=${t("chat.sidebarColumns.close", { panel: panelTitle(active.slot) })}
                title=${t("chat.sidebarColumns.close", { panel: panelTitle(active.slot) })}
                @click=${() => this.callbacks?.closeSlot(active.slot)}
              >
                ${icons.x}
              </button>`
            : nothing}
        </div>
      </div>
    `;
  }

  private renderColumn(column: SidebarColumn) {
    const active =
      column.panels.find((panel) => panel.id === column.activePanelId) ?? column.panels[0];
    return html`
      <section
        class="sidebar-column"
        data-column-id=${column.id}
        style=${styleMap({ width: `${column.width}px` })}
      >
        ${this.renderHeader(column, active?.id ?? "", false)}
        <div class="sidebar-column__body"></div>
      </section>
    `;
  }

  private renderPanel(panel: SidebarPanel, collapsed: boolean, activePanelId: string) {
    const column = this.layout.columns.find((candidate) =>
      candidate.panels.some((entry) => entry.id === panel.id),
    );
    if (!column) {
      return nothing;
    }
    const sideColumns = this.layout.columns.filter((candidate) => candidate.side === column.side);
    const columnIndex = sideColumns.findIndex((candidate) => candidate.id === column.id);
    const offsetColumns =
      column.side === "left"
        ? sideColumns.slice(0, columnIndex)
        : sideColumns.slice(columnIndex + 1);
    const offset = offsetColumns.reduce((sum, candidate) => sum + candidate.width + 4, 0);
    const panelStyle = collapsed
      ? {}
      : { [column.side]: `${offset}px`, width: `${column.width}px` };
    return html`<div
      class="sidebar-column__panel ${collapsed
        ? "sidebar-column__panel--narrow"
        : "sidebar-column__panel--wide"}"
      style=${styleMap(panelStyle)}
      ?hidden=${panel.id !== (collapsed ? activePanelId : column.activePanelId)}
    >
      ${this.panelTemplates[panel.slot]}
    </div>`;
  }

  private renderDivider(column: SidebarColumn, side: SidebarSide, columnIndex: number) {
    let divider: Element | undefined;
    return renderChatResizableDivider({
      className: "sidebar-column__divider",
      label: t("chat.sidebarColumns.resize", {
        panel: panelTitle(column.panels[0]?.slot ?? "detail"),
      }),
      orientation: "vertical",
      splitRatio: 0.5,
      minRatio: 0.05,
      maxRatio: 0.95,
      measureRatio: () => {
        const { previous, next } = this.dividerNeighbors(column, side);
        const previousWidth = previous?.width ?? 0;
        const total = previousWidth + (next?.width ?? 0);
        return total > 0 ? previousWidth / total : 0.5;
      },
      measureSize: () => {
        const { previous, next } = this.dividerNeighbors(column, side);
        return (previous?.width ?? 0) + (next?.width ?? 0);
      },
      onElement: (element) => {
        divider = element;
        if (!(element instanceof HTMLElement)) {
          return;
        }
        queueMicrotask(() => {
          const { previous, next } = this.dividerNeighbors(column, side);
          const total = (previous?.width ?? 0) + (next?.width ?? 0);
          if (total > 0) {
            (element as HTMLElement & { splitRatio: number }).splitRatio =
              (previous?.width ?? 0) / total;
          }
        });
      },
      onDragover: (event) => this.allowPanelDrop(event),
      onDrop: (event) => this.dropOnBoundary(event, side, columnIndex, divider),
      onResize: (event) => {
        const { previous, next } = this.dividerNeighbors(column, side);
        const total = (previous?.width ?? 0) + (next?.width ?? 0);
        if (total <= 0) {
          return;
        }
        const requested =
          side === "left" ? total * event.detail.splitRatio : total * (1 - event.detail.splitRatio);
        const regionWidth =
          this.availableWidth > 0
            ? this.availableWidth
            : (this.parentElement?.getBoundingClientRect().width ?? 0);
        const maxWidth = Math.max(SIDEBAR_MIN_WIDTH_PX, regionWidth * 0.6);
        this.callbacks?.resizeColumn(column.id, Math.min(requested, maxWidth));
      },
    });
  }

  private dividerNeighbors(column: SidebarColumn, side: SidebarSide) {
    const sideColumns = this.layout.columns.filter((candidate) => candidate.side === side);
    const columnIndex = sideColumns.findIndex((candidate) => candidate.id === column.id);
    const columnElements = new Map(
      Array.from(
        this.parentElement?.querySelectorAll<HTMLElement>(".sidebar-column[data-column-id]") ?? [],
        (element) => [element.dataset.columnId, element],
      ),
    );
    const primary = this.parentElement?.querySelector<HTMLElement>(".sidebar-region__primary");
    const previousElement =
      side === "left"
        ? columnElements.get(column.id)
        : columnIndex > 0
          ? columnElements.get(sideColumns[columnIndex - 1]?.id)
          : primary;
    const nextElement =
      side === "left"
        ? columnIndex + 1 < sideColumns.length
          ? columnElements.get(sideColumns[columnIndex + 1]?.id)
          : primary
        : columnElements.get(column.id);
    return {
      previous: previousElement?.getBoundingClientRect(),
      next: nextElement?.getBoundingClientRect(),
    };
  }

  private renderNarrowColumn(panels: SidebarPanel[], activePanelId: string) {
    const collapsed: SidebarColumn = {
      id: "collapsed-sidebar-column",
      side: "right",
      panels,
      activePanelId,
      width: SIDEBAR_MIN_WIDTH_PX,
    };
    return panels.length > 0
      ? html`<section class="sidebar-column sidebar-column--collapsed">
          ${this.renderHeader(collapsed, activePanelId, true)}
          <div class="sidebar-column__body"></div>
        </section>`
      : nothing;
  }

  private renderState() {
    const width = this.availableWidth > 0 ? this.availableWidth : Number.POSITIVE_INFINITY;
    const collapsed = this.narrow || isSidebarRegionCollapsed(this.layout, width);
    const panels = panelsOf(this.layout);
    const activePanelId =
      panels.find((panel) => panel.id === this.focusPanelId)?.id ??
      this.layout.columns.at(-1)?.activePanelId ??
      panels[0]?.id ??
      "";
    return { activePanelId, collapsed, panels };
  }

  private renderRight(collapsed: boolean, panels: SidebarPanel[], activePanelId: string) {
    if (collapsed) {
      return this.renderNarrowColumn(panels, activePanelId);
    }
    return this.layout.columns
      .filter((column) => column.side === "right")
      .map(
        (column, index) => html`
          ${this.renderDivider(column, "right", index)} ${this.renderColumn(column)}
        `,
      );
  }

  private renderPanels(collapsed: boolean, panels: SidebarPanel[], activePanelId: string) {
    return repeat(
      panels,
      (panel) => panel.id,
      (panel) => this.renderPanel(panel, collapsed, activePanelId),
    );
  }

  protected override updated() {
    const shell = this.parentElement;
    const rightRoot = shell?.querySelector<HTMLElement>(".sidebar-region__right-runtime");
    const panelsRoot = shell?.querySelector<HTMLElement>(".sidebar-region__panels-runtime");
    if (!rightRoot || !panelsRoot) {
      return;
    }
    const { activePanelId, collapsed, panels } = this.renderState();
    renderTemplate(this.renderRight(collapsed, panels, activePanelId), rightRoot);
    renderTemplate(this.renderPanels(collapsed, panels, activePanelId), panelsRoot);
  }

  override render() {
    const { collapsed } = this.renderState();
    const left = this.layout.columns.filter((column) => column.side === "left");
    return html`${collapsed
      ? nothing
      : html`${this.renderEmptySideDropZone("left")}${left.map(
          (column, index) => html`
            ${this.renderColumn(column)} ${this.renderDivider(column, "left", index + 1)}
          `,
        )}${this.renderEmptySideDropZone("right")}`}`;
  }
}

if (!customElements.get("openclaw-chat-sidebar-region")) {
  customElements.define("openclaw-chat-sidebar-region", ChatSidebarRegion);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-sidebar-region": ChatSidebarRegion;
  }
}
