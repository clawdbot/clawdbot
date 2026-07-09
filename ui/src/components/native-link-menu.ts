import { html } from "lit";
import { property } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";
import { activateMenuShortcut, menuShortcutHint } from "./menu-shortcuts.ts";

export type NativeLinkMenuAction = "inline" | "external" | "copy";

export class NativeLinkMenu extends OpenClawLightDomElement {
  @property({ attribute: false }) x = 0;
  @property({ attribute: false }) y = 0;
  @property({ attribute: false }) trigger: HTMLAnchorElement | null = null;
  @property({ attribute: false }) onAction: (action: NativeLinkMenuAction) => void = () => {};
  @property({ attribute: false }) onClose: () => void = () => {};

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("pointerdown", this.handleDocumentPointerDown, true);
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
  }

  override disconnectedCallback() {
    document.removeEventListener("pointerdown", this.handleDocumentPointerDown, true);
    document.removeEventListener("keydown", this.handleDocumentKeydown, true);
    super.disconnectedCallback();
  }

  protected override firstUpdated() {
    this.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }

  private readonly handleDocumentPointerDown = (event: PointerEvent) => {
    const path = event.composedPath();
    const menu = this.querySelector(".native-link-menu");
    if ((menu && path.includes(menu)) || (this.trigger && path.includes(this.trigger))) {
      return;
    }
    this.onClose();
  };

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
      <div
        class="session-menu native-link-menu"
        role="menu"
        aria-label=${t("nativeLinkMenu.label")}
        style="left: ${clampedX}px; top: ${clampedY}px;"
      >
        <button
          type="button"
          class="session-menu__item"
          role="menuitem"
          data-shortcut="s"
          aria-keyshortcuts="S"
          @click=${() => this.runAction("inline")}
        >
          <span class="session-menu__icon" aria-hidden="true">${icons.panelRightOpen}</span>
          <span class="session-menu__text">${t("nativeLinkMenu.openInline")}</span>
          ${menuShortcutHint("s")}
        </button>
        <button
          type="button"
          class="session-menu__item"
          role="menuitem"
          data-shortcut="b"
          aria-keyshortcuts="B"
          @click=${() => this.runAction("external")}
        >
          <span class="session-menu__icon" aria-hidden="true">${icons.externalLink}</span>
          <span class="session-menu__text">${t("nativeLinkMenu.openExternal")}</span>
          ${menuShortcutHint("b")}
        </button>
        <div class="session-menu__separator" role="separator"></div>
        <button
          type="button"
          class="session-menu__item"
          role="menuitem"
          data-shortcut="c"
          aria-keyshortcuts="C"
          @click=${() => this.runAction("copy")}
        >
          <span class="session-menu__icon" aria-hidden="true">${icons.copy}</span>
          <span class="session-menu__text">${t("nativeLinkMenu.copy")}</span>
          ${menuShortcutHint("c")}
        </button>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-native-link-menu")) {
  customElements.define("openclaw-native-link-menu", NativeLinkMenu);
}
