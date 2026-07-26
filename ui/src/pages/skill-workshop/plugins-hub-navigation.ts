import type { ApplicationContext } from "../../app/context.ts";
import type { PluginsHubTab } from "../../components/plugins-hub-tabs.ts";

export function selectPluginsHubTab(
  context: Pick<ApplicationContext, "navigate">,
  tab: PluginsHubTab,
) {
  if (tab === "workshop") {
    return;
  }
  if (tab === "skills") {
    context.navigate("skills");
    return;
  }
  context.navigate("plugins", tab === "discover" ? { search: "?tab=discover" } : undefined);
}
