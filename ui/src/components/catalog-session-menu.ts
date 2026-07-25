import { html } from "lit";
import { property } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";
import { promoteToPopoverTopLayer } from "./menu-surface.ts";
import "./web-awesome.ts";

export type CatalogSessionMenuAction = "viewer" | "terminal";

class CatalogSessionMenu extends OpenClawLightDomElement {
  @property({ attribute: false }) x = 0;
  @property({ attribute: false }) y = 0;
  @property({ attribute: false }) trigger: HTMLElement | null = null;
  @property({ attribute: false }) lastActive = "";
  @property({ attribute: false }) terminalDisabled = false;
  @property({ attribute: false }) onAction: (action: CatalogSessionMenuAction) => void = () => {};
  @property({ attribute: false }) onClose: () => void = () => {};

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
    promoteToPopoverTopLayer(this);
  }

  override disconnectedCallback() {
    document.removeEventListener("keydown", this.handleDocumentKeydown, true);
    super.disconnectedCallback();
  }

  protected override firstUpdated(): void {
    const dropdown = this.querySelector<HTMLElement & { updateComplete?: Promise<unknown> }>(
      "wa-dropdown",
    );
    void Promise.resolve(dropdown?.updateComplete).then(() => {
      this.querySelector<HTMLElement>("wa-dropdown-item:not([disabled])")?.focus();
    });
  }

  private readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.trigger?.focus();
      this.onClose();
    }
  };

  private run(action: CatalogSessionMenuAction) {
    // Dispatch while the controller still owns the menu snapshot; close clears it synchronously.
    this.onAction(action);
    this.onClose();
  }

  private readonly handleSelect = (
    event: CustomEvent<{ item: { value?: CatalogSessionMenuAction } }>,
  ) => {
    event.preventDefault();
    const action = event.detail.item.value;
    if (action) {
      this.run(action);
    }
  };

  private readonly handleAfterHide = (event: Event) => {
    if (event.currentTarget instanceof Node && event.currentTarget.isConnected) {
      this.onClose();
    }
  };

  override render() {
    const menuWidth = 240;
    const menuMaxHeight = 140;
    const x = Math.max(8, Math.min(this.x, window.innerWidth - menuWidth - 8));
    const y = Math.max(8, Math.min(this.y, window.innerHeight - menuMaxHeight - 8));
    const menuLabel = t("chat.catalog.sessionMenu");
    return html`
      <wa-dropdown
        class="session-menu"
        .open=${true}
        placement="bottom-start"
        .distance=${0}
        aria-label=${menuLabel}
        @wa-select=${this.handleSelect}
        @wa-after-hide=${this.handleAfterHide}
      >
        <button
          slot="trigger"
          type="button"
          tabindex="-1"
          aria-hidden="true"
          aria-label=${menuLabel}
          style="position: fixed; left: ${x}px; top: ${y}px; width: 1px; height: 1px; opacity: 0; pointer-events: none;"
        ></button>
        ${this.lastActive
          ? html`<div class="session-menu__info">
              ${t("sessionsView.lastActive", { time: this.lastActive })}
            </div>`
          : ""}
        <wa-dropdown-item class="session-menu__item" value="viewer">
          <span slot="icon" class="session-menu__icon" aria-hidden="true"
            >${icons.messageSquare}</span
          >
          <span class="session-menu__text">${t("chat.catalog.openInOpenClaw")}</span>
        </wa-dropdown-item>
        <wa-dropdown-item
          class="session-menu__item"
          value="terminal"
          title=${this.terminalDisabled ? t("chat.catalog.terminalUnavailable") : ""}
          ?disabled=${this.terminalDisabled}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.terminal}</span>
          <span class="session-menu__text">${t("chat.catalog.openInTerminal")}</span>
        </wa-dropdown-item>
      </wa-dropdown>
    `;
  }
}

if (!customElements.get("openclaw-catalog-session-menu")) {
  customElements.define("openclaw-catalog-session-menu", CatalogSessionMenu);
}
