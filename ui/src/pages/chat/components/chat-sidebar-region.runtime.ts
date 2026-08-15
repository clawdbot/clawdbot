import { html, nothing, render as renderTemplate, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";
import { icons } from "../../../components/icons.ts";
import { renderPanelTabStrip } from "../../../components/panel-tab-strip.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  type PanelToggleElement,
} from "../../../components/panel-toggle-contract.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import {
  SIDEBAR_MIN_HEIGHT_PX,
  SIDEBAR_MIN_WIDTH_PX,
  sidebarDock,
  type SidebarColumn,
  type SidebarLayout,
  type SidebarPanel,
  type SidebarSlotId,
} from "../sidebar-layout.ts";
import { renderChatResizableDivider } from "./chat-resizable-divider.ts";
import type { SidebarPanelTemplates, SidebarRegionCallbacks } from "./chat-sidebar-region-types.ts";

type PanelType = {
  slot: SidebarSlotId;
  label: string;
  description: string;
  icon: TemplateResult;
  shortcut?: string;
};

function panelType(slot: SidebarSlotId): PanelType {
  switch (slot) {
    case "browser":
      return {
        slot,
        label: t("chat.sidePanel.browser"),
        description: t("chat.sidePanel.browserEmpty"),
        icon: icons.globe,
      };
    case "chat":
      return {
        slot,
        label: t("chat.sidePanel.boardChat"),
        description: t("chat.sidePanel.boardChatEmpty"),
        icon: icons.messageSquare,
      };
    case "companion":
      return {
        slot,
        label: t("chat.sidePanel.companion"),
        description: t("chat.sidePanel.companionEmpty"),
        icon: icons.bot,
      };
    case "desktop":
      return {
        slot,
        label: t("chat.sidePanel.desktop"),
        description: t("chat.sidePanel.desktopEmpty"),
        icon: icons.monitor,
      };
    case "detail":
      return {
        slot,
        label: t("chat.sidePanel.review"),
        description: t("chat.sidePanel.reviewEmpty"),
        icon: icons.diff,
      };
    case "discussion":
      return {
        slot,
        label: t("chat.sidePanel.discussion"),
        description: t("chat.sidePanel.discussionEmpty"),
        icon: icons.messageSquare,
      };
    case "tasks":
      return {
        slot,
        label: t("chat.sidePanel.tasks"),
        description: t("chat.sidePanel.tasksEmpty"),
        icon: icons.listChecks,
      };
    case "terminal":
      return {
        slot,
        label: t("chat.sidePanel.terminal"),
        description: t("chat.sidePanel.terminalEmpty"),
        icon: icons.terminal,
        shortcut: "Ctrl+`",
      };
    case "workspace":
      return {
        slot,
        label: t("chat.sidePanel.files"),
        description: t("chat.sidePanel.filesEmpty"),
        icon: icons.fileText,
        shortcut: "⇧⌘B",
      };
  }
}

function renderPanelTypeOption(type: PanelType, slotted = false) {
  return html`
    <span slot=${slotted ? "icon" : nothing} class="side-panel-type-option__icon" aria-hidden="true"
      >${type.icon}</span
    >
    <span class="side-panel-type-option__label">${type.label}</span>
    ${type.shortcut
      ? html`<kbd slot=${slotted ? "details" : nothing} class="side-panel-type-option__shortcut"
          >${type.shortcut}</kbd
        >`
      : nothing}
  `;
}

function panelsOf(layout: SidebarLayout): SidebarPanel[] {
  return layout.columns[0]?.panels ?? [];
}

class ChatSidebarRegion extends OpenClawLightDomElement {
  @property({ attribute: false }) layout: SidebarLayout = { columns: [] };
  @property({ attribute: false }) panelTemplates: SidebarPanelTemplates = {};
  @property({ attribute: false }) panelOpenUrls: Partial<Record<SidebarSlotId, string | null>> = {};
  @property({ attribute: false }) availableSlots: SidebarSlotId[] = [];
  @property({ attribute: false }) callbacks: SidebarRegionCallbacks | null = null;
  @property({ type: Boolean }) narrow = false;
  @property({ type: Number }) availableWidth = 0;

  deliverPanelEvent(slot: SidebarSlotId, event: Event): boolean {
    const panel = this.parentElement?.querySelector<HTMLElement>(
      `[data-panel-slot="${slot}"]`,
    )?.firstElementChild;
    if (
      !(panel instanceof HTMLElement) ||
      typeof (panel as Partial<PanelToggleElement>).handleToggleRequest !== "function"
    ) {
      return false;
    }
    (panel as PanelToggleElement).handleToggleRequest(event);
    return true;
  }

  private panelTypes(): PanelType[] {
    return this.availableSlots.map(panelType);
  }

  private renderTypeMenu() {
    const openSlots = new Set(panelsOf(this.layout).map((panel) => panel.slot));
    return html`
      <wa-dropdown
        class="side-panel-type-menu"
        placement="bottom-end"
        @wa-select=${(event: CustomEvent<{ item: { value?: SidebarSlotId } }>) => {
          const slot = event.detail.item.value;
          if (slot) {
            this.callbacks?.openSlot(slot);
            if (slot === "browser" && openSlots.has(slot)) {
              this.deliverPanelEvent(
                slot,
                new CustomEvent(BROWSER_PANEL_TOGGLE_EVENT, {
                  detail: { open: true, newTab: true },
                }),
              );
            }
          }
        }}
      >
        <button
          slot="trigger"
          class="rail-header__action side-panel-type-menu__trigger"
          type="button"
          aria-label=${t("chat.sidePanel.addTab")}
          title=${t("chat.sidePanel.addTab")}
        >
          ${icons.plus}
        </button>
        ${this.panelTypes()
          .filter((type) => type.slot === "browser" || !openSlots.has(type.slot))
          .map(
            (type) => html`
              <wa-dropdown-item
                class="side-panel-type-menu__item session-menu__item"
                .value=${type.slot}
              >
                ${renderPanelTypeOption(type, true)}
              </wa-dropdown-item>
            `,
          )}
      </wa-dropdown>
    `;
  }

  private renderHeader(column: SidebarColumn) {
    const tabs = column.panels.map((panel) => {
      const type = panelType(panel.slot);
      return {
        id: panel.id,
        domId: `side-panel-tab-${panel.id}`,
        label: type.label,
        icon: type.icon,
        closeLabel: t("chat.sidebarColumns.close", { panel: type.label }),
      };
    });
    const active = column.panels.find((panel) => panel.id === column.activePanelId) ?? tabs[0];
    const activePanel = column.panels.find((panel) => panel.id === active?.id);
    const openUrl = activePanel ? this.panelOpenUrls[activePanel.slot] : null;
    return html`
      <header class="rail-header side-panel__header">
        ${renderPanelTabStrip({
          tabs,
          activeId: active?.id ?? null,
          ariaControls: "chat-side-panel-content",
          onSelect: (panelId) => this.callbacks?.activatePanel(panelId),
          onClose: (panelId) => {
            const panel = column.panels.find((entry) => entry.id === panelId);
            if (panel) {
              this.callbacks?.closeSlot(panel.slot);
            }
          },
          onNew: () => undefined,
          newLabel: t("chat.sidePanel.addTab"),
          newControl: this.renderTypeMenu(),
          separateTabs: true,
          onReorder: (panelId, targetPanelId, placement) =>
            this.callbacks?.reorderPanel(panelId, targetPanelId, placement),
        })}
        <div class="rail-header__actions side-panel__actions">
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
          ${this.renderDockControls()}
          <openclaw-tooltip
            .content=${t(this.layout.expanded ? "chat.sidePanel.restore" : "chat.sidePanel.expand")}
          >
            <button
              class="rail-header__action side-panel__expand"
              type="button"
              aria-pressed=${String(this.layout.expanded === true)}
              aria-label=${t(
                this.layout.expanded ? "chat.sidePanel.restore" : "chat.sidePanel.expand",
              )}
              @click=${() => this.callbacks?.setExpanded(this.layout.expanded !== true)}
            >
              ${this.layout.expanded ? icons.minimize : icons.maximize}
            </button>
          </openclaw-tooltip>
          <openclaw-tooltip .content=${t("chat.sidePanel.minimize")}>
            <button
              class="rail-header__action side-panel__minimize"
              type="button"
              aria-label=${t("chat.sidePanel.minimize")}
              @click=${() => this.callbacks?.setOpen(false)}
            >
              ${sidebarDock(this.layout) === "bottom"
                ? icons.panelBottomClose
                : icons.panelRightClose}
            </button>
          </openclaw-tooltip>
        </div>
      </header>
    `;
  }

  private renderDockControls() {
    if (this.narrow) {
      return nothing;
    }
    const dock = sidebarDock(this.layout);
    return html`
      <openclaw-tooltip .content=${t("browser.dockBottom")}>
        <button
          class="rail-header__action side-panel__dock-bottom"
          type="button"
          aria-pressed=${String(dock === "bottom")}
          aria-label=${t("browser.dockBottom")}
          @click=${() => this.callbacks?.setDock("bottom")}
        >
          ${icons.panelBottomOpen}
        </button>
      </openclaw-tooltip>
      <openclaw-tooltip .content=${t("browser.dockRight")}>
        <button
          class="rail-header__action side-panel__dock-right"
          type="button"
          aria-pressed=${String(dock === "right")}
          aria-label=${t("browser.dockRight")}
          @click=${() => this.callbacks?.setDock("right")}
        >
          ${icons.panelRightOpen}
        </button>
      </openclaw-tooltip>
    `;
  }

  private renderEmpty(panel?: SidebarPanel) {
    if (panel) {
      const type = panelType(panel.slot);
      return html`<div class="side-panel-empty side-panel-empty--type">
        <span class="side-panel-empty__icon" aria-hidden="true">${type.icon}</span>
        <strong class="side-panel-empty__title">${type.label}</strong>
        <p class="side-panel-empty__description">${type.description}</p>
      </div>`;
    }
    return html`<div class="side-panel-empty side-panel-empty--selector">
      <strong class="side-panel-empty__title">${t("chat.sidePanel.emptyTitle")}</strong>
      <p class="side-panel-empty__description">${t("chat.sidePanel.emptyDescription")}</p>
      <div class="side-panel-empty__types" role="list">
        ${this.panelTypes().map(
          (type) => html`<button
            class="side-panel-empty__type"
            type="button"
            role="listitem"
            @click=${() => this.callbacks?.openSlot(type.slot)}
          >
            ${renderPanelTypeOption(type)}
          </button>`,
        )}
      </div>
    </div>`;
  }

  private renderBody(column?: SidebarColumn) {
    if (!column) {
      return html`<div id="chat-side-panel-content" class="side-panel__body">
        ${this.renderEmpty()}
      </div>`;
    }
    return html`<div id="chat-side-panel-content" class="side-panel__body">
      ${repeat(
        column.panels,
        (panel) => panel.id,
        (panel) => html`<div
          class="side-panel__panel"
          data-panel-slot=${panel.slot}
          ?hidden=${panel.id !== column.activePanelId}
        >
          ${this.panelTemplates[panel.slot] ?? this.renderEmpty(panel)}
        </div>`,
      )}
    </div>`;
  }

  private renderDivider(column: SidebarColumn) {
    const dock = sidebarDock(this.layout);
    const measure = () => {
      const shell = this.parentElement;
      const primary = shell?.querySelector<HTMLElement>(".sidebar-region__primary");
      const panel = shell?.querySelector<HTMLElement>(".side-panel");
      const primarySize =
        dock === "bottom"
          ? (primary?.getBoundingClientRect().height ?? 0)
          : (primary?.getBoundingClientRect().width ?? 0);
      const panelSize =
        dock === "bottom"
          ? (panel?.getBoundingClientRect().height ?? column.height)
          : (panel?.getBoundingClientRect().width ?? column.width);
      return { primarySize, total: primarySize + panelSize };
    };
    return renderChatResizableDivider({
      className: "sidebar-column__divider",
      label: t("chat.sidePanel.resize"),
      orientation: dock === "bottom" ? "horizontal" : "vertical",
      splitRatio: 0.5,
      minRatio: 0.05,
      maxRatio: 0.95,
      measureRatio: () => {
        const { primarySize, total } = measure();
        return total > 0 ? primarySize / total : 0.5;
      },
      measureSize: () => measure().total,
      onResize: (event) => {
        const bounds = this.parentElement?.getBoundingClientRect();
        const regionSize =
          dock === "bottom"
            ? (bounds?.height ?? 0)
            : this.availableWidth > 0
              ? this.availableWidth
              : (bounds?.width ?? 0);
        const total = measure().total || regionSize;
        const requested = total * (1 - event.detail.splitRatio);
        const minimum = dock === "bottom" ? SIDEBAR_MIN_HEIGHT_PX : SIDEBAR_MIN_WIDTH_PX;
        const maximum = Math.max(minimum, regionSize * 0.6);
        this.callbacks?.resizePanel(column.id, Math.max(minimum, Math.min(requested, maximum)));
      },
    });
  }

  private renderPanel() {
    if (this.layout.open !== true) {
      return nothing;
    }
    const column = this.layout.columns[0];
    const dock = sidebarDock(this.layout);
    const width = this.layout.expanded || dock === "bottom" ? "100%" : `${column?.width ?? 360}px`;
    const height = this.layout.expanded || dock === "right" ? "100%" : `${column?.height ?? 360}px`;
    return html`${!this.narrow && !this.layout.expanded && column
        ? this.renderDivider(column)
        : nothing}
      <section
        class="sidebar-column side-panel ${this.narrow ? "side-panel--narrow" : ""} ${this.layout
          .expanded
          ? "side-panel--expanded"
          : ""} ${dock === "bottom" ? "side-panel--bottom" : ""}"
        style=${styleMap({ width, height })}
        aria-label=${t("chat.sidePanel.label")}
      >
        ${column
          ? this.renderHeader(column)
          : html`<header class="rail-header side-panel__header side-panel__header--empty">
              <strong class="side-panel__empty-header-title">${t("chat.sidePanel.label")}</strong>
              <div class="rail-header__actions side-panel__actions">
                ${this.renderTypeMenu()} ${this.renderDockControls()}
                <openclaw-tooltip
                  .content=${t(
                    this.layout.expanded ? "chat.sidePanel.restore" : "chat.sidePanel.expand",
                  )}
                >
                  <button
                    class="rail-header__action side-panel__expand"
                    type="button"
                    aria-pressed=${String(this.layout.expanded === true)}
                    aria-label=${t(
                      this.layout.expanded ? "chat.sidePanel.restore" : "chat.sidePanel.expand",
                    )}
                    @click=${() => this.callbacks?.setExpanded(this.layout.expanded !== true)}
                  >
                    ${this.layout.expanded ? icons.minimize : icons.maximize}
                  </button>
                </openclaw-tooltip>
                <button
                  class="rail-header__action side-panel__minimize"
                  type="button"
                  aria-label=${t("chat.sidePanel.minimize")}
                  @click=${() => this.callbacks?.setOpen(false)}
                >
                  ${dock === "bottom" ? icons.panelBottomClose : icons.panelRightClose}
                </button>
              </div>
            </header>`}
        ${this.renderBody(column)}
      </section>`;
  }

  protected override updated() {
    const root = this.parentElement?.querySelector<HTMLElement>(".sidebar-region__right-runtime");
    if (root) {
      renderTemplate(this.renderPanel(), root);
    }
  }

  override render() {
    return nothing;
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
