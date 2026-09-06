import { html, nothing, type TemplateResult } from "lit";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { renderLearnMoreLink } from "../../components/settings-ui.ts";
import { renderPluginsHubTabs, type PluginsHubTab } from "./plugins-hub.ts";

const HUB_COPY = {
  plugins: {
    route: "plugins",
    docsUrl: "https://docs.openclaw.ai/plugins/manage-plugins",
  },
  skills: {
    route: "skills",
    docsUrl: "https://docs.openclaw.ai/tools/skills",
  },
} as const;

type PluginsHubHeaderProps = {
  active: PluginsHubTab;
  onSelect: (tab: PluginsHubTab) => void;
  secondaryAction?: {
    label: string;
    onClick: () => void;
  };
};

export function renderPluginsHubHeader(props: PluginsHubHeaderProps): TemplateResult {
  const copy = HUB_COPY[props.active];
  return html`
    <section
      class="content-header content-header--settings content-header--page hub-page-header plugins-hub-header"
    >
      <div class="hub-page-header__tabs">
        ${renderPluginsHubTabs({ active: props.active, onSelect: props.onSelect })}
      </div>
      <div class="hub-page-header__title">
        <h1 class="page-title">${titleForRoute(copy.route)}</h1>
        <div class="page-subtitle">
          ${subtitleForRoute(copy.route)} ${renderLearnMoreLink(copy.docsUrl)}
        </div>
      </div>
      <div class="hub-page-header__actions">
        ${
          props.secondaryAction
            ? html`<button
                type="button"
                class="btn btn--sm plugins-hub-header__secondary oc-action oc-action-secondary"
                @click=${props.secondaryAction.onClick}
              >
                ${props.secondaryAction.label}
              </button>`
            : nothing
        }
      </div>
    </section>
  `;
}
