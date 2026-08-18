import { html, type TemplateResult } from "lit";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { renderDocsLink } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { renderPluginsHubTabs, type PluginsHubTab } from "./plugins-hub.ts";

const PLUGINS_DOCS_URL = "https://docs.openclaw.ai/plugins/manage-plugins";

type PluginsHubHeaderProps = {
  active: PluginsHubTab;
  onSelect: (tab: PluginsHubTab) => void;
};

export function renderPluginsHubHeader(props: PluginsHubHeaderProps): TemplateResult {
  return html`
    <section class="content-header content-header--page hub-page-header plugins-hub-header">
      <div class="hub-page-header__title">
        <h1 class="page-title">${titleForRoute("plugins")}</h1>
        <div class="page-subtitle">
          ${subtitleForRoute("plugins")} ${renderDocsLink(PLUGINS_DOCS_URL, t("common.learnMore"))}
        </div>
      </div>
      <div class="hub-page-header__tabs">
        ${renderPluginsHubTabs({ active: props.active, onSelect: props.onSelect })}
      </div>
      <div class="hub-page-header__actions"></div>
    </section>
  `;
}
