import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { selectableAgentsList } from "../../lib/agents/display.ts";
import type { AgentsRouteData } from "./agents-page.ts";

async function loadAgentsRouteData(
  context: ApplicationContext,
  location: RouteLocation,
): Promise<AgentsRouteData> {
  const gateway = context.gateway;
  const gatewaySnapshot = gateway.snapshot;
  const rawAgentsList = context.agents.state.agentsList ?? (await context.agents.ensureList());
  const agentsList = rawAgentsList ? selectableAgentsList(rawAgentsList) : null;
  const requestedAgentId = new URLSearchParams(location.search).get("agent")?.trim() || null;
  const requestedAgent = requestedAgentId
    ? (agentsList?.agents.find((entry) => entry.id === requestedAgentId)?.id ?? null)
    : null;
  return {
    gateway,
    gatewaySnapshot,
    agentsList,
    selectedAgentId: requestedAgent ?? agentsList?.defaultId ?? agentsList?.agents[0]?.id ?? null,
    error: context.agents.state.agentsError,
  };
}

export const page = definePage({
  id: "agents",
  path: "/settings/agents",
  aliases: ["/agents"],
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) => location.search,
  loader: (context: ApplicationContext, { location }) => loadAgentsRouteData(context, location),
  component: () =>
    import("./agents-page.ts").then(() => ({
      header: true,
      render: (data: AgentsRouteData | undefined) =>
        html`<openclaw-agents-page .routeData=${data}></openclaw-agents-page>`,
    })),
});
