import { renderHubTabs, type HubTabOption } from "../../components/hub-tabs.ts";
import { t } from "../../i18n/index.ts";

export type PluginsHubTab = "installed" | "discover" | "skills" | "workshop";

export const PLUGINS_HUB_PANEL_ID = "plugins-hub-panel";

function pluginsHubTabs(): ReadonlyArray<HubTabOption<PluginsHubTab>> {
  return [
    { value: "installed", label: t("pluginsPage.installedTab") },
    { value: "discover", label: t("pluginsPage.discoverTab") },
    { value: "skills", label: t("tabs.skills") },
    { value: "workshop", label: t("pluginsPage.workshopTab") },
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
    onSelect: props.onSelect,
  });
}
