import { LitElement, html } from "lit";
import { property } from "lit/decorators.js";
import type { ThemeMode } from "../app/theme.ts";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";
import "./tooltip.ts";

export type ThemeModeChangeDetail = {
  mode: ThemeMode;
  element: HTMLElement;
};

const MODE_ORDER: ThemeMode[] = ["system", "light", "dark"];

function getNextMode(current: ThemeMode, direction: "next" | "prev"): ThemeMode {
  const currentIndex = MODE_ORDER.indexOf(current);
  if (currentIndex === -1) {
    return MODE_ORDER[0];
  }
  const nextIndex =
    direction === "next"
      ? (currentIndex + 1) % MODE_ORDER.length
      : (currentIndex - 1 + MODE_ORDER.length) % MODE_ORDER.length;
  return MODE_ORDER[nextIndex];
}

export class ThemeModeToggle extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) mode: ThemeMode = "system";

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
  }

  private readonly handleModeChange = (mode: ThemeMode, event: Event) => {
    if (mode === this.mode) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent<ThemeModeChangeDetail>("theme-change", {
        detail: { mode, element: event.currentTarget as HTMLElement },
        bubbles: true,
        composed: true,
      }),
    );
  };

  private readonly handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? "next" : "prev";
    const nextMode = getNextMode(this.mode, direction);
    this.handleModeChange(nextMode, event);
  };

  override render() {
    const options: Array<{ id: ThemeMode; labelKey: string; icon: string }> = [
      { id: "system", labelKey: "common.system", icon: icons.monitor },
      { id: "light", labelKey: "common.light", icon: icons.sun },
      { id: "dark", labelKey: "common.dark", icon: icons.moon },
    ];

    const activeIndex = options.findIndex((option) => option.id === this.mode);

    return html`
      <div
        class="topbar-theme-mode"
        role="group"
        aria-label=${t("common.colorMode")}
        @keydown=${this.handleKeyDown}
      >
        ${options.map((option, index) => {
          const label = t(option.labelKey);
          const tooltip = t("common.colorModeOption", { mode: label });
          const isActive = option.id === this.mode;
          return html`
            <openclaw-tooltip .content=${tooltip}>
              <button
                type="button"
                class="topbar-theme-mode__btn ${isActive ? "topbar-theme-mode__btn--active" : ""}"
                aria-label=${tooltip}
                aria-pressed=${isActive}
                tabindex=${index === activeIndex ? "0" : "-1"}
                @click=${(event: Event) => this.handleModeChange(option.id, event)}
              >
                ${option.icon}
              </button>
            </openclaw-tooltip>
          `;
        })}
      </div>
    `;
  }
}

if (!customElements.get("openclaw-theme-mode-toggle")) {
  customElements.define("openclaw-theme-mode-toggle", ThemeModeToggle);
}
