import "../../../styles/chat/side-panel.css";
import { html, nothing, render as renderTemplate, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../../components/icons.ts";
import { renderPanelEmptyState } from "../../../components/panel-empty-state.ts";
import { renderPanelTabStrip } from "../../../components/panel-tab-strip.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  type PanelToggleElement,
} from "../../../components/panel-toggle-contract.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { sidebarPanelDefinitions } from "../chat-pane-embedded-panels.ts";
import {
  SIDEBAR_GEOMETRY_COMMIT_EVENT,
  SIDEBAR_MIN_HEIGHT_PX,
  SIDEBAR_MIN_WIDTH_PX,
  sidebarDock,
  sidebarMainPanel,
  sidebarSidePanels,
  sidebarActivePanel,
  isSidebarSlotVisible,
  type SidebarColumn,
  type SidebarLayout,
  type SidebarPanel,
  type SidebarSlotId,
} from "../sidebar-layout.ts";
import { renderChatResizableDivider } from "./chat-resizable-divider.ts";
import type {
  SidebarPanelDefinition,
  SidebarPanelTemplates,
  SidebarRegionCallbacks,
} from "./chat-sidebar-region-types.ts";

function panelType(
  definitions: SidebarPanelDefinition[],
  slot: SidebarSlotId,
): SidebarPanelDefinition {
  const definition = definitions.find((candidate) => candidate.slot === slot);
  if (!definition) {
    throw new Error(`Missing sidebar panel definition for ${slot}`);
  }
  return definition;
}

function renderPanelTypeOption(type: SidebarPanelDefinition, slotted = false) {
  return html`
    <span slot=${slotted ? "icon" : nothing} class="side-panel-type-option__icon" aria-hidden="true"
      >${type.icon}</span
    >
    <span class="side-panel-type-option__label">${type.label}</span>
    ${
      type.shortcut
        ? html`<kbd slot=${slotted ? "details" : nothing} class="side-panel-type-option__shortcut"
            >${type.shortcut}</kbd
          >`
        : nothing
    }
  `;
}

function panelsOf(layout: SidebarLayout): SidebarPanel[] {
  return layout.columns[0]?.panels ?? [];
}

class ChatSidebarRegion extends OpenClawLightDomElement {
  @property({ attribute: false }) layout: SidebarLayout = { columns: [] };
  @property({ attribute: false }) panelDefinitions = sidebarPanelDefinitions();
  @property({ attribute: false }) panelTemplates: SidebarPanelTemplates = {};
  // Header actions owned by the active panel. The tabbed model gives a panel no
  // header of its own, so an action on its content (open externally, clear the
  // thread) is only reachable if the panel contributes it to the shared header.
  @property({ attribute: false }) panelActions: SidebarPanelTemplates = {};
  @property({ attribute: false }) availableSlots: SidebarSlotId[] = [];
  @property({ attribute: false }) callbacks: SidebarRegionCallbacks | null = null;
  @property({ type: Boolean }) narrow = false;
  @property({ type: Number }) availableWidth = 0;
  private previousGeometry = "";
  private contentMounted = false;

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

  private panelTypes(): SidebarPanelDefinition[] {
    return this.availableSlots.map((slot) => panelType(this.panelDefinitions, slot));
  }

  private renderTypeMenu() {
    const openSlots = new Set(panelsOf(this.layout).map((panel) => panel.slot));
    return html`
      <wa-dropdown
        class="side-panel-type-menu"
        placement="bottom-start"
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
    const tabs = sidebarSidePanels(this.layout).map((panel) => {
      const type = panelType(this.panelDefinitions, panel.slot);
      return {
        id: panel.id,
        domId: `side-panel-tab-${panel.id}`,
        label: type.label,
        labelTooltip: type.label,
        icon: type.icon,
        closeLabel: t("chat.sidebarColumns.close", { panel: type.label }),
      };
    });
    const active = sidebarActivePanel(this.layout);
    const activePanel = column.panels.find((panel) => panel.id === active?.id);
    const activeActions = (activePanel ? this.panelActions[activePanel.slot] : null) ?? null;
    return html`
      <header class="rail-header side-panel__header" data-region-header="side">
        <div class="side-panel__header-tabs">
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
            newControl: nothing,
            separateTabs: true,
            onReorder: (panelId, targetPanelId, placement) =>
              this.callbacks?.reorderPanel(panelId, targetPanelId, placement),
          })}
          ${this.renderTypeMenu()}
        </div>
        ${this.renderHeaderActions(activeActions)}
      </header>
    `;
  }

  private renderHeaderActions(panelActions: TemplateResult | typeof nothing | null) {
    return html`<div class="rail-header__actions side-panel__actions">
      ${
        panelActions
          ? html`<span class="side-panel__action-group side-panel__action-group--content">
              ${panelActions}
            </span>`
          : nothing
      }
      <span class="side-panel__action-group side-panel__action-group--close">
        <openclaw-tooltip .content=${t("common.close")}>
          <button
            class="rail-header__action side-panel__minimize"
            type="button"
            aria-label=${t("common.close")}
            @click=${() => this.callbacks?.setOpen(false)}
          >
            ${icons.x}
          </button>
        </openclaw-tooltip>
      </span>
    </div>`;
  }

  private renderEmpty(panel?: SidebarPanel) {
    if (panel) {
      const type = panelType(this.panelDefinitions, panel.slot);
      return html`<div class="side-panel-empty side-panel-empty--type">
        ${renderPanelEmptyState({
          icon: type.icon,
          heading: type.label,
          description: type.empty.description,
          action: type.empty.action,
        })}
      </div>`;
    }
    return html`<div class="side-panel-empty side-panel-empty--selector">
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
    return html`<div id="chat-side-panel-content" class="side-panel__body">
      ${repeat(
        // Tab reordering must not physically move live iframe/custom-element roots.
        this.panelDefinitions.flatMap((definition) =>
          (column?.panels ?? []).filter(
            (panel) => panel.slot === definition.slot && panel.slot !== "conversation",
          ),
        ),
        (panel) => panel.id,
        (panel) => html`<div
          class="side-panel__panel"
          data-panel-slot=${panel.slot}
          data-region=${panel.id === this.layout.mainPanelId ? "main" : "side"}
          ?hidden=${!isSidebarSlotVisible(this.layout, panel.slot)}
        >
          ${this.panelTemplates[panel.slot] ?? this.renderEmpty(panel)}
        </div>`,
      )}
      ${
        sidebarSidePanels(this.layout).length === 0
          ? html`<div class="side-panel__empty-body" data-region="side">${this.renderEmpty()}</div>`
          : nothing
      }
    </div>`;
  }

  private renderDivider(column: SidebarColumn) {
    const dock = sidebarDock(this.layout);
    const measure = () => {
      const shell = this.parentElement;
      const primary = shell?.querySelector<HTMLElement>('[data-region="main"]');
      const panel = shell?.querySelector<HTMLElement>('[data-region="side"]:not([hidden])');
      const primarySize =
        dock === "bottom"
          ? (primary?.getBoundingClientRect().height ?? 0)
          : (primary?.getBoundingClientRect().width ?? 0);
      const panelSize =
        dock === "bottom"
          ? (panel?.getBoundingClientRect().height ?? column.height)
          : (panel?.getBoundingClientRect().width ?? column.width);
      return { primarySize, panelSize, total: primarySize + panelSize };
    };
    return renderChatResizableDivider({
      className: "sidebar-column__divider",
      label: t("chat.sidePanel.resize"),
      orientation: dock === "bottom" ? "horizontal" : "vertical",
      splitRatio: 0.5,
      minRatio: 0.05,
      maxRatio: 0.95,
      measureRatio: () => {
        const { primarySize, panelSize, total } = measure();
        return total > 0 ? (dock === "left" ? panelSize : primarySize) / total : 0.5;
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
        const requested =
          total * (dock === "left" ? event.detail.splitRatio : 1 - event.detail.splitRatio);
        const minimum = dock === "bottom" ? SIDEBAR_MIN_HEIGHT_PX : SIDEBAR_MIN_WIDTH_PX;
        const maximum = Math.max(minimum, regionSize * 0.6);
        this.callbacks?.resizePanel(column.id, Math.max(minimum, Math.min(requested, maximum)));
      },
    });
  }

  private renderPanel() {
    const column = this.layout.columns[0];
    if (!column) {
      this.contentMounted = false;
      return nothing;
    }
    // Saved closed panels stay dormant until first shown. Once mounted, their
    // content survives hiding; closing tabs or this region releases it.
    this.contentMounted ||=
      (this.layout.open === true && !this.layout.expanded) ||
      (sidebarMainPanel(this.layout)?.slot ?? "conversation") !== "conversation";
    return html`${
        !this.narrow && this.layout.open && !this.layout.expanded && column
          ? this.renderDivider(column)
          : nothing
      }
      <section class="side-panel" aria-label=${t("chat.sidePanel.label")}>
        ${column && sidebarSidePanels(this.layout).length > 0 ? this.renderHeader(column) : nothing}
        ${this.contentMounted ? this.renderBody(column) : nothing}
      </section>`;
  }

  protected override updated() {
    const root = this.parentElement?.querySelector<HTMLElement>(".sidebar-region__right-runtime");
    if (root) {
      renderTemplate(this.renderPanel(), root);
      const panel = root.querySelector<HTMLElement>(".side-panel");
      const geometry = Array.from(
        this.parentElement!.querySelectorAll<HTMLElement>(
          ".sidebar-region__primary, .side-panel__panel",
        ),
        (content) =>
          `${content.dataset.panelSlot ?? "conversation"}:${content.getBoundingClientRect().width}`,
      ).join(":");
      // The manual panel render is the commit boundary for its transcript.
      // Track content, not region roles: swapping can keep the same main/side
      // widths while changing the transcript width and its row measurements.
      panel?.dispatchEvent(
        new CustomEvent(SIDEBAR_GEOMETRY_COMMIT_EVENT, {
          bubbles: true,
          detail: {
            widthChanged: geometry !== this.previousGeometry,
          },
        }),
      );
      this.previousGeometry = geometry;
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
