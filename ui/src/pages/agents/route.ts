import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { AgentsListResult } from "../../api/types.ts";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { selectableAgentsList } from "../../lib/agents/display.ts";
import { resolveAgentsRouteLocation, type AgentsRouteLocation } from "./route-location.ts";

export type AgentsRouteData = AgentsRouteLocation & {
  // Client identity alone cannot distinguish provider replacement or reconnect epochs.
  gateway: ApplicationContext["gateway"];
  gatewaySnapshot: ApplicationGatewaySnapshot;
  agentsList: AgentsListResult | null;
  selectedAgentId: string | null;
  error: string | null;
};

async function loadAgentsRouteData(
  context: ApplicationContext,
  location: RouteLocation,
): Promise<AgentsRouteData> {
  const route = resolveAgentsRouteLocation(location, context.basePath);
  const gateway = context.gateway;
  const gatewaySnapshot = gateway.snapshot;
  const rawAgentsList = context.agents.state.agentsList ?? (await context.agents.ensureList());
  const agentsList = rawAgentsList ? selectableAgentsList(rawAgentsList) : null;
  const requestedAgent = route.requestedAgentId
    ? (agentsList?.agents.find((entry) => entry.id === route.requestedAgentId)?.id ?? null)
    : null;
  // Unknown explicit ids keep their URL while the roster selection falls back,
  // matching the shipped ?agent= behavior without an automatic mount redirect.
  return {
    ...route,
    gateway,
    gatewaySnapshot,
    agentsList,
    selectedAgentId: requestedAgent ?? agentsList?.defaultId ?? agentsList?.agents[0]?.id ?? null,
    error: context.agents.state.agentsError,
  };
}

export const page = definePage({
  ...routePageSpec("agents"),
  loaderDeps: (context: ApplicationContext, location: RouteLocation) => {
    const route = resolveAgentsRouteLocation(location, context.basePath).location;
    return `${route.pathname}\u0000${route.search}\u0000${route.hash}`;
  },
  loader: (context: ApplicationContext, { location }) => loadAgentsRouteData(context, location),
  component: () =>
    import("./agents-page.ts").then(() => ({
      header: true,
      render: (data: AgentsRouteData | undefined) =>
        html`<openclaw-agents-page .routeData=${data}></openclaw-agents-page>`,
    })),
});
