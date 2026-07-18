import { html, nothing, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { beginNativeWindowDrag } from "../app/native-window-drag.ts";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";
import "./tooltip.ts";

class MacosTitlebarControls extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) navCollapsed = false;
  @property({ attribute: false }) historyOnly = false;
  @property({ attribute: false }) canGoBack = false;
  @property({ attribute: false }) canGoForward = false;
  @property({ attribute: false }) onToggleSidebar?: () => void;
  @property({ attribute: false }) onOpenPalette?: () => void;
  @property({ attribute: false }) onOpenNewSession?: () => void;

  override render() {
    const toggleLabel = this.navCollapsed ? t("nav.expand") : t("nav.collapse");
    return html`
      <nav class="macos-titlebar-controls" @mousedown=${beginNativeWindowDrag}>
        ${this.historyOnly
          ? nothing
          : this.renderButton({
              label: toggleLabel,
              icon: this.navCollapsed ? icons.panelLeftOpen : icons.panelLeftClose,
              ariaExpanded: !this.navCollapsed,
              onClick: this.onToggleSidebar,
              className: "macos-titlebar-controls__sidebar-toggle",
            })}
        ${this.renderButton({
          label: t("nav.back"),
          icon: icons.chevronLeft,
          disabled: !this.canGoBack,
          onClick: () => globalThis.history.back(),
          className: "macos-titlebar-controls__back",
        })}
        ${this.renderButton({
          label: t("nav.forward"),
          icon: icons.chevronRight,
          disabled: !this.canGoForward,
          onClick: () => globalThis.history.forward(),
          className: "macos-titlebar-controls__forward",
        })}
        ${!this.historyOnly
          ? html`
              ${this.renderButton({
                label: t("chat.openCommandPalette"),
                tooltip: t("chat.commandPaletteTitle"),
                icon: icons.search,
                onClick: this.onOpenPalette,
                className: "macos-titlebar-controls__search",
              })}
              ${this.renderButton({
                // Deliberately not connection-gated: it mirrors the native
                // ⌘N menu item (handleNativeNewSession), and the new-session
                // route is offline-tolerant. Window chrome stays state-free.
                label: t("chat.runControls.newSession"),
                icon: icons.plus,
                onClick: this.onOpenNewSession,
                className: "macos-titlebar-controls__new-session",
              })}
            `
          : nothing}
      </nav>
    `;
  }

  private renderButton(options: {
    label: string;
    tooltip?: string;
    icon: TemplateResult;
    disabled?: boolean;
    ariaExpanded?: boolean;
    onClick?: () => void;
    className: string;
  }) {
    return html`
      <openclaw-tooltip .content=${options.tooltip ?? options.label}>
        <button
          type="button"
          class="topbar-icon-btn macos-titlebar-controls__button ${options.className}"
          aria-label=${options.label}
          aria-expanded=${options.ariaExpanded === undefined
            ? nothing
            : String(options.ariaExpanded)}
          ?disabled=${options.disabled || !options.onClick}
          @click=${options.onClick}
        >
          ${options.icon}
        </button>
      </openclaw-tooltip>
    `;
  }
}

if (!customElements.get("openclaw-macos-titlebar-controls")) {
  customElements.define("openclaw-macos-titlebar-controls", MacosTitlebarControls);
}
