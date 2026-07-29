import type { HubTabOption } from "../../components/hub-tabs.ts";
import { t } from "../../i18n/index.ts";

export type PluginsHubTab = "installed" | "discover" | "skills" | "workshop";

export const PLUGINS_HUB_PANEL_ID = "plugins-hub-panel";

export function pluginsHubTabs(
  installedCount: number | null = null,
): ReadonlyArray<HubTabOption<PluginsHubTab>> {
  return [
    { value: "installed", label: t("pluginsPage.installedTab"), count: installedCount },
    { value: "discover", label: t("pluginsPage.discoverTab") },
    { value: "skills", label: t("tabs.skills") },
    { value: "workshop", label: t("pluginsPage.workshopTab") },
  ];
}
