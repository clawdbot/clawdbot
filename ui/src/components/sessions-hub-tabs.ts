import { t } from "../i18n/index.ts";
import { renderHubTabs, type HubTabOption } from "./hub-tabs.ts";

export type SessionsHubTab = "sessions" | "worktrees";

type SessionsHubTabsProps = {
  active: SessionsHubTab;
  onSelect: (tab: SessionsHubTab) => void;
};

function hubTabs(): ReadonlyArray<HubTabOption<SessionsHubTab>> {
  return [
    { value: "sessions", label: t("tabs.sessions") },
    { value: "worktrees", label: t("tabs.worktrees") },
  ];
}

/** Every route marks its main content with id="sessions-hub-panel". */
export function renderSessionsHubTabs(props: SessionsHubTabsProps) {
  return renderHubTabs({
    id: "sessions",
    active: props.active,
    tabs: hubTabs(),
    ariaLabel: t("sessionsPage.hubTablistLabel"),
    panelId: "sessions-hub-panel",
    onSelect: props.onSelect,
  });
}
