import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { listSelectableAgents } from "../../lib/agents/display.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { newSessionLocationFromSearch, type NewSessionRouteData } from "./location.ts";

async function loadNewSessionData(
  context: ApplicationContext,
  search: string,
): Promise<NewSessionRouteData> {
  const requestedLocation = newSessionLocationFromSearch(search);
  const requestedAgentId = requestedLocation.agentId.trim();
  if (!requestedLocation.catalogId) {
    return { ...requestedLocation, requestedAgentId, model: "", catalogLabel: "" };
  }
  const { resolveAgentId, resolveCreateTarget } = await import("./catalog-target.ts");
  const unresolved = (agentId = ""): NewSessionRouteData => ({
    ...requestedLocation,
    agentId,
    requestedAgentId,
    model: "",
    catalogLabel: "",
  });
  const initialGateway = context.gateway.snapshot;
  const initialAgentsState = context.agents.state;
  if (
    initialGateway.phase !== "connected" ||
    !initialGateway.client ||
    !initialAgentsState.connected ||
    initialAgentsState.client !== initialGateway.client
  ) {
    return unresolved();
  }
  // ensureList is fail-closed: offline and request-error paths return cached
  // data or null, allowing the unresolved catalog page to mount and retry.
  const loadedAgentsList = initialAgentsState.agentsList ?? (await context.agents.ensureList());
  const gateway = context.gateway.snapshot;
  const agentsState = context.agents.state;
  if (
    gateway.phase !== "connected" ||
    !gateway.client ||
    gateway.client !== initialGateway.client ||
    !agentsState.connected ||
    agentsState.client !== gateway.client ||
    agentsState.agentsList !== loadedAgentsList
  ) {
    return unresolved();
  }
  const agentsList = loadedAgentsList;
  const availableAgents = listSelectableAgents(agentsList?.agents ?? []);
  const gatewayDefaultId =
    gateway.phase === "connected" && gateway.hello ? gateway.assistantAgentId : null;
  if (
    !agentsList &&
    requestedAgentId &&
    (!gatewayDefaultId || normalizeAgentId(requestedAgentId) !== normalizeAgentId(gatewayDefaultId))
  ) {
    return unresolved();
  }
  const fallbackAgentId = agentsList
    ? availableAgents.some((agent) => agent.id === agentsList.defaultId)
      ? agentsList.defaultId
      : availableAgents[0]?.id
    : gatewayDefaultId;
  const agentId = fallbackAgentId
    ? agentsList
      ? resolveAgentId(requestedLocation, availableAgents, fallbackAgentId)
      : resolveAgentId(undefined, [], fallbackAgentId)
    : "";
  const plain = unresolved(agentId);
  if (gateway.phase !== "connected" || !gateway.client || !agentId) {
    return plain;
  }
  const target = await resolveCreateTarget(gateway.client, requestedLocation.catalogId, agentId);
  return target ? { ...plain, ...target } : plain;
}

export const page = definePage({
  ...routePageSpec("new-session"),
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) => location.search,
  loader: (context: ApplicationContext, { location }) =>
    loadNewSessionData(context, location.search),
  component: () =>
    import("./new-session-page.ts").then(() => ({
      render: (data: unknown) =>
        html`<openclaw-new-session-page .data=${data}></openclaw-new-session-page>`,
    })),
});
