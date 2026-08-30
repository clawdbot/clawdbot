import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import {
  SESSION_COLOR_IDS,
  normalizeSessionColorValue,
} from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { t } from "../i18n/index.ts";
import { EDITOR_IDS, EDITOR_LABELS } from "../lib/editor-links.ts";
import { icons } from "./icons.ts";
import { menuShortcutHint } from "./menu-shortcuts.ts";
import { renderSessionColorDot } from "./session-color.ts";
import { syncDropdownItemRadio } from "./web-awesome.ts";

export function renderSessionEditorOptions(params: { inline: boolean; disabled: boolean }) {
  return html`
    ${EDITOR_IDS.map(
      (editor) => html`
        <wa-dropdown-item
          slot=${params.inline ? nothing : "submenu"}
          class="session-menu__item"
          value=${`open-in:${editor}`}
          ?disabled=${params.disabled}
        >
          <span class="session-menu__text">${EDITOR_LABELS[editor]}</span>
        </wa-dropdown-item>
      `,
    )}
  `;
}

export function renderSessionGroupOptions(params: {
  inline: boolean;
  category: string | null;
  categoryClearReturnsToGroups: boolean;
  groups: readonly string[];
  actionDisabled: (kind: "move-to-group" | "new-group") => boolean;
  actionTitle: (kind: "move-to-group" | "new-group") => string | typeof nothing;
}) {
  let nextDigit = 1;
  const takeDigit = () => (nextDigit <= 9 ? String(nextDigit++) : null);
  const entry = (label: string, checked: boolean, value: string, radio = true) => {
    const digit = takeDigit();
    const actionKind = value === "new-group" ? "new-group" : "move-to-group";
    return html`
      <wa-dropdown-item
        slot=${params.inline ? nothing : "submenu"}
        class="session-menu__item"
        value=${value}
        role=${radio ? "menuitemradio" : "menuitem"}
        aria-checked=${radio ? String(checked) : nothing}
        ${radio ? ref((element) => syncDropdownItemRadio(element, checked)) : nothing}
        data-shortcut=${digit ?? nothing}
        aria-keyshortcuts=${digit ?? nothing}
        ?disabled=${params.actionDisabled(actionKind)}
        title=${params.actionTitle(actionKind)}
      >
        <span class="session-menu__text">${label}</span>
        ${radio && checked
          ? html`<span slot="details" class="session-menu__check" aria-hidden="true"
              >${icons.check}</span
            >`
          : nothing}
        ${digit ? menuShortcutHint(digit) : nothing}
      </wa-dropdown-item>
    `;
  };
  return html`
    ${params.groups.map((group) =>
      entry(group, params.category === group, `move-to-group:${encodeURIComponent(group)}`),
    )}
    ${params.category
      ? entry(
          t(
            params.categoryClearReturnsToGroups
              ? "sessionsView.moveBackToGroups"
              : "sessionsView.removeFromGroup",
          ),
          false,
          "move-to-group:",
          false,
        )
      : nothing}
    ${entry(t("sessionsView.newGroup"), false, "new-group", false)}
  `;
}

export function renderSessionColorOptions(params: {
  inline: boolean;
  color: string | null;
  disabled: boolean;
  disabledReason?: string;
}) {
  const current = normalizeSessionColorValue(params.color ?? "");
  return html`${[null, ...SESSION_COLOR_IDS].map((color) => {
    const checked = current === color;
    return html`<wa-dropdown-item
      slot=${params.inline ? nothing : "submenu"}
      class="session-menu__item"
      value=${`set-color:${color ?? ""}`}
      role="menuitemradio"
      aria-checked=${String(checked)}
      ${ref((element) => syncDropdownItemRadio(element, checked))}
      ?disabled=${params.disabled}
      title=${params.disabledReason ?? nothing}
    >
      <span slot="icon" aria-hidden="true">${renderSessionColorDot(color)}</span>
      <span class="session-menu__text"
        >${color ? t(`sessionsView.colors.${color}`) : t("common.default")}</span
      >
      ${checked
        ? html`<span slot="details" class="session-menu__check" aria-hidden="true"
            >${icons.check}</span
          >`
        : nothing}
    </wa-dropdown-item>`;
  })}`;
}
