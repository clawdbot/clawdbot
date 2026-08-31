import { pathForAgentPanel } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { DEFAULT_AGENT_PANEL, type AgentsPanel } from "../../lib/agents/panels.ts";
import type { AgentsRouteData } from "./route.ts";

type AgentsNavigationContext = Pick<ApplicationContext, "basePath" | "navigate" | "replace">;
type AgentsCanonicalRouteData = Pick<AgentsRouteData, "location" | "canonicalLocation">;

export function syncAgentsCanonicalLocation(
  context: AgentsNavigationContext,
  routeData: AgentsCanonicalRouteData | undefined,
  normalizedLocation: string,
): string {
  const canonical = routeData?.canonicalLocation;
  if (!canonical) {
    return "";
  }
  const source = `${routeData.location.pathname}${routeData.location.search}${routeData.location.hash}`;
  if (normalizedLocation !== source) {
    context.replace("agents", canonical);
  }
  return source;
}

export function navigateToAgent(
  context: AgentsNavigationContext,
  agentId: string,
  selectedAgentId: string | null,
  activePanel: AgentsPanel,
) {
  if (selectedAgentId === agentId) {
    return;
  }
  context.navigate("agents", {
    pathname: pathForAgentPanel(
      agentId,
      activePanel === DEFAULT_AGENT_PANEL ? null : activePanel,
      context.basePath,
    ),
  });
}

export function navigateToAgentPanel(
  context: AgentsNavigationContext,
  agentId: string | null,
  activePanel: AgentsPanel,
  panel: AgentsPanel,
) {
  if (!agentId || panel === activePanel) {
    return;
  }
  context.navigate("agents", {
    pathname: pathForAgentPanel(agentId, panel, context.basePath),
  });
}
