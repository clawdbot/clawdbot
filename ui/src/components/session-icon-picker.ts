import { html, nothing } from "lit";
import {
  normalizeSessionIconValue,
  SESSION_ICON_GLYPH_IDS,
} from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";
import { resolveSessionIconGlyph } from "./session-icon-glyph-registry.ts";

const SESSION_ICON_EMOJI_CHOICES = [
  "🦞",
  "🚀",
  "🐛",
  "✅",
  "🔥",
  "📦",
  "🧪",
  "📝",
  "🔍",
  "⚡",
  "🎯",
] as const;

function sessionEmojiPickerShortcut(): string | null {
  const platform = globalThis.navigator?.platform ?? "";
  if (/Mac|iPhone|iPad|iPod/u.test(platform)) {
    return "⌃⌘Space";
  }
  return /Win/u.test(platform) ? "Win+." : null;
}

type SessionIconPickerProps = {
  mode: "grid" | "custom";
  currentIcon: string | null;
  customIconValue: string;
  disabled: boolean;
  disabledReason?: string;
  onSelect: (event: MouseEvent, icon: string) => void;
  onShowCustom: (event: MouseEvent) => void;
  onBack: (event: Event) => void;
  onInput: (event: InputEvent) => void;
  onApply: (event: Event) => void;
  onRemove: (event: MouseEvent) => void;
  onGridKeydown: (event: KeyboardEvent) => void;
};

function renderCustomSessionIconEntry(props: SessionIconPickerProps) {
  const normalized = normalizeSessionIconValue(props.customIconValue);
  const shortcut = sessionEmojiPickerShortcut();
  return html`
    <div slot="submenu" class="session-menu__icon-picker session-menu__icon-custom-entry">
      <div class="session-menu__icon-custom-header">
        <button
          type="button"
          class="session-menu__icon-back"
          aria-label=${t("common.back")}
          @click=${props.onBack}
        >
          ${icons.arrowLeft}
        </button>
        <span>${t("sessionsView.customEmojiTitle")}</span>
      </div>
      <div class="session-menu__icon-custom-controls">
        <input
          class="session-menu__icon-custom-input"
          type="text"
          autocomplete="off"
          autofocus
          aria-label=${t("sessionsView.customEmojiTitle")}
          .value=${props.customIconValue}
          @input=${props.onInput}
        />
        <button
          type="button"
          class="session-menu__icon-set"
          ?disabled=${!normalized || props.disabled}
          @click=${props.onApply}
        >
          ${t("sessionsView.customEmojiSet")}
        </button>
      </div>
      <div class="session-menu__icon-custom-hint">
        ${shortcut
          ? t("sessionsView.customEmojiHint", { shortcut })
          : t("sessionsView.customEmojiHintNoShortcut")}
      </div>
    </div>
  `;
}

export function renderSessionIconPicker(props: SessionIconPickerProps) {
  if (props.mode === "custom") {
    return renderCustomSessionIconEntry(props);
  }
  const tabStop = [...SESSION_ICON_EMOJI_CHOICES, ...SESSION_ICON_GLYPH_IDS].find(
    (icon) => icon === props.currentIcon,
  );
  return html`
    <div slot="submenu" class="session-menu__icon-picker">
      <div
        class="session-menu__icon-options"
        role="group"
        aria-label=${t("sessionsView.setIconMenu")}
        @keydown=${props.onGridKeydown}
      >
        <div class="session-menu__icon-section-label">${t("sessionsView.iconEmojiSection")}</div>
        <div class="session-menu__icon-grid">
          ${SESSION_ICON_EMOJI_CHOICES.map((icon, index) => {
            const checked = props.currentIcon === icon;
            return html`
              <button
                type="button"
                class="session-menu__icon-choice"
                aria-pressed=${String(checked)}
                tabindex=${icon === tabStop || (!tabStop && index === 0) ? "0" : "-1"}
                ?disabled=${props.disabled}
                title=${props.disabledReason ?? nothing}
                @click=${(event: MouseEvent) => props.onSelect(event, icon)}
              >
                ${icon}
              </button>
            `;
          })}
          <button
            type="button"
            class="session-menu__icon-choice session-menu__icon-choice--custom"
            aria-label=${t("sessionsView.customEmojiCell")}
            aria-pressed="false"
            tabindex="-1"
            ?disabled=${props.disabled}
            title=${props.disabledReason ?? nothing}
            @click=${props.onShowCustom}
          >
            ${icons.moreHorizontal}
          </button>
        </div>
        <div class="session-menu__icon-section-label">${t("sessionsView.iconGlyphSection")}</div>
        <div class="session-menu__icon-grid">
          ${SESSION_ICON_GLYPH_IDS.map((icon) => {
            const checked = props.currentIcon === icon;
            return html`
              <button
                type="button"
                class="session-menu__icon-choice session-menu__icon-choice--glyph"
                aria-label=${icon}
                aria-pressed=${String(checked)}
                tabindex=${icon === tabStop ? "0" : "-1"}
                ?disabled=${props.disabled}
                title=${props.disabledReason ?? nothing}
                @click=${(event: MouseEvent) => props.onSelect(event, icon)}
              >
                ${resolveSessionIconGlyph(icon)}
              </button>
            `;
          })}
        </div>
      </div>
      ${props.currentIcon
        ? html`
            <div class="session-menu__icon-separator" role="separator"></div>
            <button
              type="button"
              class="session-menu__icon-remove"
              ?disabled=${props.disabled}
              title=${props.disabledReason ?? nothing}
              @click=${props.onRemove}
            >
              ${t("sessionsView.removeIcon")}
            </button>
          `
        : nothing}
    </div>
  `;
}
