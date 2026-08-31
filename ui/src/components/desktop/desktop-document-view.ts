import { html, nothing, svg } from "lit";
import { t } from "../../i18n/index.ts";
import { strokeIcon } from "../icons-tools.ts";
import { icons } from "../icons.ts";
import { renderPanelLoadingSkeleton } from "../panel-loading-skeleton.ts";
import type { DesktopPanelState } from "./desktop-panel-state.ts";

const KEYBOARD_GLYPH = strokeIcon(svg`
  <rect width="20" height="14" x="2" y="5" rx="2" />
  <path d="M6 9h.01" />
  <path d="M10 9h.01" />
  <path d="M14 9h.01" />
  <path d="M18 9h.01" />
  <path d="M6 13h.01" />
  <path d="M10 13h.01" />
  <path d="M14 13h.01" />
  <path d="M18 13h.01" />
  <path d="M8 17h8" />
`);

type DesktopDocumentViewOptions = {
  state: DesktopPanelState;
  controlling: boolean;
  scaleViewport: boolean;
  notice: unknown;
  picker: unknown;
  credentials: unknown;
  recovery: unknown;
  keyboardInputValue: string;
  onControlToggle: () => void;
  onKeyboardFocus: () => void;
  onKeyboardEvent: (event: KeyboardEvent) => void;
  onKeyboardInput: (event: InputEvent) => void;
  onScaleToggle: () => void;
  onClose: () => void;
};

export function renderDesktopDocumentView(options: DesktopDocumentViewOptions) {
  const connection = html`
    <div class="desktop-stage">
      <div class="desktop-surface"></div>
      ${options.state === "connecting"
        ? renderPanelLoadingSkeleton("desktop", t("desktop.connecting"), false, true)
        : nothing}
      <textarea
        class="desktop-keyboard-input"
        inputmode="text"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        tabindex="-1"
        aria-label=${t("desktop.keyboardInput")}
        .value=${options.keyboardInputValue}
        @keydown=${options.onKeyboardEvent}
        @keyup=${options.onKeyboardEvent}
        @input=${options.onKeyboardInput}
      ></textarea>
      <nav class="desktop-touch-toolbar" aria-label=${t("desktop.touchControls")}>
        <button
          class="desktop-touch-action"
          type="button"
          aria-label=${t(options.controlling ? "desktop.switchToViewOnly" : "desktop.takeControl")}
          aria-pressed=${options.controlling ? "true" : "false"}
          @click=${options.onControlToggle}
        >
          <span class="desktop-touch-action__icon" aria-hidden="true">
            ${options.controlling ? icons.hand : icons.eye}
          </span>
          <span class="desktop-touch-action__label">
            ${t(options.controlling ? "desktop.control" : "desktop.viewOnly")}
          </span>
        </button>
        <button
          class="desktop-touch-action"
          type="button"
          aria-label=${t("desktop.keyboard")}
          @click=${options.onKeyboardFocus}
        >
          <span class="desktop-touch-action__icon" aria-hidden="true">${KEYBOARD_GLYPH}</span>
          <span class="desktop-touch-action__label">${t("desktop.keyboard")}</span>
        </button>
        <button
          class="desktop-touch-action"
          type="button"
          aria-label=${t(options.scaleViewport ? "desktop.actualSize" : "desktop.fitScreen")}
          aria-pressed=${options.scaleViewport ? "true" : "false"}
          @click=${options.onScaleToggle}
        >
          <span class="desktop-touch-action__icon" aria-hidden="true">
            ${options.scaleViewport ? icons.minimize : icons.maximize}
          </span>
          <span class="desktop-touch-action__label">${t("desktop.fit")}</span>
        </button>
        <button
          class="desktop-touch-action"
          type="button"
          aria-label=${t("desktop.back")}
          @click=${options.onClose}
        >
          <span class="desktop-touch-action__icon" aria-hidden="true">${icons.arrowLeft}</span>
          <span class="desktop-touch-action__label">${t("desktop.back")}</span>
        </button>
      </nav>
    </div>
  `;

  return html`
    <section class="desktop-document" aria-label=${t("desktop.title")}>
      <div class="desktop-content">
        ${options.notice}
        ${options.state === "picker"
          ? options.picker
          : options.state === "inventory-error" || options.state === "disconnected"
            ? options.recovery
            : options.state === "credentials"
              ? options.credentials
              : connection}
      </div>
    </section>
  `;
}
