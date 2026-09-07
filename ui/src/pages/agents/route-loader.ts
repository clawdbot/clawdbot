import type { RouteLocation } from "@openclaw/uirouter";
import type { ApplicationContext } from "../../app/context.ts";
import { selectableAgentsList } from "../../lib/agents/display.ts";
import { resolveAgentsRouteLocation } from "./route-location.ts";
import type { AgentsRouteData } from "./route.ts";

export async function load(
  context: ApplicationContext,
  location: RouteLocation,
): Promise<AgentsRouteData> {
  const route = resolveAgentsRouteLocation(location, context.basePath);
  const gateway = context.gateway;
  const gatewaySnapshot = gateway.snapshot;
  const rawAgentsList = context.agents.state.agentsList ?? (await context.agents.ensureList());
  const agentsList = rawAgentsList ? selectableAgentsList(rawAgentsList) : null;
  return {
    ...route,
    gateway,
    gatewaySnapshot,
    agentsList,
    error: context.agents.state.agentsError,
  };
}
