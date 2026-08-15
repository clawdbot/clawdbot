import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";

export function renderChatModelCatalogHint(params: {
  catalogMode?: "replace";
  modelSettingsHref?: string;
}) {
  if (params.catalogMode !== "replace") {
    return nothing;
  }
  return html`
    <div class="chat-controls__catalog-hint" role="note">
      <span>${t("chat.selectors.replaceModeHint")}</span>
      ${params.modelSettingsHref
        ? html`<a href=${params.modelSettingsHref}>${t("chat.selectors.manageModels")}</a>`
        : nothing}
    </div>
  `;
}
