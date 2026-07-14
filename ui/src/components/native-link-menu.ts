import { html } from "lit";
import { property } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";
import { activateMenuShortcut, menuShortcutHint } from "./menu-shortcuts.ts";
import "./web-awesome.ts";

export type NativeLinkMenuAction = "inline" | "external" | "copy";

export class NativeLinkMenu extends OpenClawLightDomElement {
  @property({ attribute: false }) x = 0;
  @property({ attribute: false }) y = 0;
  @property({ attribute: false }) trigger: HTMLAnchorElement | null = null;
  @property({ attribute: false }) onAction: (action: NativeLinkMenuAction) => void = () => {};
  @property({ attribute: false }) onClose: () => void = () => {};

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
  }

  override disconnectedCallback() {
    document.removeEventListener("keydown", this.handleDocumentKeydown, true);
    super.disconnectedCallback();
  }

  protected override firstUpdated() {
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
      return;
    }
    activateMenuShortcut(this, event);
  };

  private runAction(action: NativeLinkMenuAction) {
    this.onClose();
    this.onAction(action);
  }

  override render() {
    const menuWidth = 264;
    const menuMaxHeight = 136;
    const clampedX = Math.max(8, Math.min(this.x, window.innerWidth - menuWidth - 8));
    const clampedY = Math.max(8, Math.min(this.y, window.innerHeight - menuMaxHeight - 8));
    return html`
      <wa-dropdown
        class="session-menu native-link-menu"
        .open=${true}
        placement="bottom-start"
        .distance=${0}
        aria-label=${t("nativeLinkMenu.label")}
        @wa-select=${(event: CustomEvent<{ item: { value?: NativeLinkMenuAction } }>) => {
          event.preventDefault();
          const action = event.detail.item.value;
          if (action) {
            this.trigger?.focus();
            this.runAction(action);
          }
        }}
        @wa-after-hide=${() => {
          this.onClose();
        }}
      >
        <button
          slot="trigger"
          type="button"
          tabindex="-1"
          aria-hidden="true"
          aria-label=${t("nativeLinkMenu.label")}
          style="position: fixed; left: ${clampedX}px; top: ${clampedY}px; width: 1px; height: 1px; opacity: 0; pointer-events: none;"
        ></button>
        <wa-dropdown-item
          class="session-menu__item"
          value="inline"
          data-shortcut="s"
          aria-keyshortcuts="S"
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true"
            >${icons.panelRightOpen}</span
          >
          <span class="session-menu__text">${t("nativeLinkMenu.openInline")}</span>
          ${menuShortcutHint("s")}
        </wa-dropdown-item>
        <wa-dropdown-item
          class="session-menu__item"
          value="external"
          data-shortcut="b"
          aria-keyshortcuts="B"
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true"
            >${icons.externalLink}</span
          >
          <span class="session-menu__text">${t("nativeLinkMenu.openExternal")}</span>
          ${menuShortcutHint("b")}
        </wa-dropdown-item>
        <div class="session-menu__separator" role="separator"></div>
        <wa-dropdown-item
          class="session-menu__item"
          value="copy"
          data-shortcut="c"
          aria-keyshortcuts="C"
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.copy}</span>
          <span class="session-menu__text">${t("nativeLinkMenu.copy")}</span>
          ${menuShortcutHint("c")}
        </wa-dropdown-item>
      </wa-dropdown>
    `;
  }
}

if (!customElements.get("openclaw-native-link-menu")) {
  customElements.define("openclaw-native-link-menu", NativeLinkMenu);
}
