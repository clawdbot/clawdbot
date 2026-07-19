// Shared tab strip for the Sessions hub: the sessions and worktrees routes
// render it under one header so the two surfaces read as tabs of a single
// page even though each tab keeps its own route and loader (same pattern as
// plugins-hub-tabs.ts).
import { html } from "lit";
import { t } from "../i18n/index.ts";
import "./web-awesome-tabs.ts";

type SessionsHubTab = "sessions" | "worktrees";

const HUB_TABS: readonly SessionsHubTab[] = ["sessions", "worktrees"];

type SessionsHubTabsProps = {
  active: SessionsHubTab;
  onSelect: (tab: SessionsHubTab) => void;
};

function hubTabLabel(tab: SessionsHubTab): string {
  switch (tab) {
    case "sessions":
      return t("tabs.sessions");
    case "worktrees":
      return t("tabs.worktrees");
    default:
      return tab satisfies never;
  }
}

/**
 * Every hub page marks its main content container with
 * id="sessions-hub-panel" so aria-controls stays valid on each route.
 * Styled as page-level navigation (.hub-tabs in ui/src/styles/plugins.css).
 */
export function renderSessionsHubTabs(props: SessionsHubTabsProps) {
  return html`
    <wa-tab-group
      class="hub-tabs plugins-hub-tabs sessions-hub-tabs"
      aria-label=${t("sessionsPage.hubTablistLabel")}
      .active=${props.active}
      activation="manual"
      without-scroll-controls
      @wa-tab-show=${(event: CustomEvent<{ name: SessionsHubTab }>) =>
        props.onSelect(event.detail.name)}
    >
      ${HUB_TABS.map((tab) => {
        const selected = props.active === tab;
        return html`
          <wa-tab
            id=${`sessions-tab-${tab}`}
            panel=${tab}
            aria-controls="sessions-hub-panel"
            class="hub-tab"
            ?active=${selected}
          >
            ${hubTabLabel(tab)}
          </wa-tab>
        `;
      })}
    </wa-tab-group>
  `;
}
