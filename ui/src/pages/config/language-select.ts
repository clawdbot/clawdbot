import { html } from "lit";
import "../../components/web-awesome-select.ts";
import { SUPPORTED_LOCALES, t, type Locale } from "../../i18n/index.ts";

export function languageLabel(locale: Locale) {
  const key = locale.replace(/-([a-zA-Z])/g, (_, character) => character.toUpperCase());
  return t(`languages.${key}`);
}

export function renderLanguageSelect(
  locale: Locale | undefined,
  resolvedLocale: Locale,
  onChange: (locale: Locale | undefined) => void,
) {
  const value = locale ?? "system";
  const systemLabel = `${t("common.system")} (${languageLabel(resolvedLocale)})`;
  return html`
    <wa-select
      class="settings-select"
      .value=${value}
      @change=${(event: Event) => {
        const next = (event.currentTarget as HTMLElement & { value: string }).value;
        onChange(next === "system" ? undefined : (next as Locale));
      }}
    >
      <span slot="label" class="settings-control__sr-label">${t("quickSettings.language")}</span>
      <wa-option value="system" .label=${systemLabel} .selected=${value === "system"}>
        ${systemLabel}
      </wa-option>
      ${SUPPORTED_LOCALES.map((option) => {
        const label = languageLabel(option);
        return html`
          <wa-option value=${option} .label=${label} .selected=${option === value}>
            ${label}
          </wa-option>
        `;
      })}
    </wa-select>
  `;
}
