import { pathForPluginsHubTab } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { PluginsHubTab } from "../../components/plugins-hub-tabs.ts";

export function selectPluginsHubTab(
  context: Pick<ApplicationContext, "basePath" | "navigate">,
  tab: PluginsHubTab,
) {
  if (tab === "workshop") {
    return;
  }
  if (tab === "skills") {
    context.navigate("skills");
    return;
  }
  context.navigate("plugins", {
    pathname: pathForPluginsHubTab(tab, context.basePath),
  });
}
