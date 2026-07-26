import { html } from "lit";
import { t } from "../i18n/index.ts";
import { renderHubTabs, type HubTabOption } from "./hub-tabs.ts";

export type PluginsHubTab = "installed" | "discover" | "skills" | "workshop";

type PluginsHubTabsProps = {
  active: PluginsHubTab;
  /** Installed-plugin count badge; omit on pages without catalog data. */
  installedCount?: number | null;
  onSelect: (tab: PluginsHubTab) => void;
};

function hubTabs(installedCount: number | null): ReadonlyArray<HubTabOption<PluginsHubTab>> {
  return [
    {
      value: "installed",
      label: t("pluginsPage.installedTab"),
      badge:
        installedCount === null
          ? undefined
          : html`<span class="settings-count">${installedCount}</span>`,
    },
    { value: "discover", label: t("pluginsPage.discoverTab") },
    { value: "skills", label: t("tabs.skills") },
    { value: "workshop", label: t("pluginsPage.workshopTab") },
  ];
}

/** Every route marks its main content with id="plugins-hub-panel". */
export function renderPluginsHubTabs(props: PluginsHubTabsProps) {
  return renderHubTabs({
    id: "plugins",
    active: props.active,
    tabs: hubTabs(props.installedCount ?? null),
    ariaLabel: t("pluginsPage.hubTablistLabel"),
    panelId: "plugins-hub-panel",
    className: "plugins-tabs",
    onSelect: props.onSelect,
  });
}
