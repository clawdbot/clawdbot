import { html } from "lit";
import "../../components/web-awesome-select.ts";
import { SUPPORTED_LOCALES, t, type Locale } from "../../i18n/index.ts";

export function renderLanguageSelect(locale: Locale, onChange: (locale: Locale) => void) {
  return html`
    <wa-select
      class="settings-select"
      value=${locale}
      @change=${(event: Event) =>
        onChange((event.currentTarget as HTMLElement & { value: string }).value as Locale)}
    >
      <span slot="label" class="settings-control__sr-label">${t("quickSettings.language")}</span>
      ${SUPPORTED_LOCALES.map((option) => {
        const key = option.replace(/-([a-zA-Z])/g, (_, character) => character.toUpperCase());
        const label = t(`languages.${key}`);
        return html`
          <wa-option value=${option} .label=${label} .selected=${option === locale}>
            ${label}
          </wa-option>
        `;
      })}
    </wa-select>
  `;
}
