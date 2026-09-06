import { renderHubTabs, type HubTabOption } from "../../components/hub-tabs.ts";
import { t } from "../../i18n/index.ts";

export type PluginsHubTab = "plugins" | "skills";

export const PLUGINS_HUB_PANEL_ID = "plugins-hub-panel";

function pluginsHubTabs(): ReadonlyArray<HubTabOption<PluginsHubTab>> {
  return [
    { value: "plugins", label: t("tabs.plugins") },
    { value: "skills", label: t("tabs.skills") },
  ];
}

export function renderPluginsHubTabs(props: {
  active: PluginsHubTab;
  onSelect: (tab: PluginsHubTab) => void;
}) {
  return renderHubTabs({
    id: "plugins",
    active: props.active,
    tabs: pluginsHubTabs(),
    ariaLabel: t("pluginsPage.hubTablistLabel"),
    panelId: PLUGINS_HUB_PANEL_ID,
    className: "plugins-tabs",
    carapace: true,
    variant: "sub",
    onSelect: props.onSelect,
  });
}
