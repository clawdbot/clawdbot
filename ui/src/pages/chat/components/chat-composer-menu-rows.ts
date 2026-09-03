import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";

export function menuDivider(): TemplateResult {
  return html`<div class="agent-chat__capability-menu-divider" role="separator"></div>`;
}

export function renderBackRow() {
  return html`
    <wa-dropdown-item class="agent-chat__capability-menu-item" value="back">
      <span slot="icon" aria-hidden="true">${icons.arrowLeft}</span>
      <span>${t("chat.composer.menu.back")}</span>
    </wa-dropdown-item>
    ${menuDivider()}
  `;
}

export function renderCapabilityToggleRow(options: {
  value: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  title: string | null | undefined;
  icon?: TemplateResult;
  note?: TemplateResult | typeof nothing;
  checkbox?: boolean;
}) {
  return html`
    <wa-dropdown-item
      class="agent-chat__capability-menu-item agent-chat__capability-menu-toggle"
      value=${options.value}
      type=${options.checkbox ? "checkbox" : "normal"}
      .checked=${options.checked}
      ?disabled=${options.disabled}
      title=${options.title ?? ""}
    >
      ${options.icon ? html`<span slot="icon" aria-hidden="true">${options.icon}</span>` : nothing}
      <span class="agent-chat__capability-menu-label">
        <span>${options.label}</span>
        ${options.note ?? nothing}
      </span>
      ${options.checkbox
        ? nothing
        : html`<wa-switch
            slot="details"
            class="agent-chat__capability-menu-switch"
            size="s"
            tabindex="-1"
            .checked=${options.checked}
            ?disabled=${options.disabled}
            aria-label=${options.label}
          ></wa-switch>`}
    </wa-dropdown-item>
  `;
}
