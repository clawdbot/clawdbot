import type { ApplicationContext } from "../../app/context.ts";
import { listSelectableAgents } from "../../lib/agents/display.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { resolveAgentId, resolveCreateTarget } from "./catalog-target.ts";
import { newSessionLocationFromSearch, type NewSessionRouteData } from "./location.ts";

export async function load(
  context: ApplicationContext,
  search: string,
): Promise<NewSessionRouteData> {
  const requestedLocation = newSessionLocationFromSearch(search);
  const requestedAgentId = requestedLocation.agentId.trim();
  let groupCwd = "";
  let groupWorktree = false;
  let groupStatus: NewSessionRouteData["groupStatus"];
  let groupCatalogGeneration: number | undefined;
  let groupDefaultsStatus: NewSessionRouteData["groupDefaultsStatus"];
  if (requestedLocation.group) {
    const startedGeneration = context.sessions.groupsGeneration();
    const settings = await context.sessions.groupsLoad();
    groupCatalogGeneration = context.sessions.groupsGeneration();
    groupDefaultsStatus = context.sessions.groupsStatus();
    const currentSettings =
      startedGeneration === groupCatalogGeneration && groupDefaultsStatus === "ready"
        ? settings
        : null;
    const group = currentSettings?.find((candidate) => candidate.name === requestedLocation.group);
    groupStatus = currentSettings === null ? "unavailable" : group ? "resolved" : "missing";
    groupCwd = group?.cwd ?? "";
    groupWorktree = group?.worktree === true;
  }
  if (!requestedLocation.catalogId) {
    return {
      ...requestedLocation,
      requestedAgentId,
      groupStatus,
      groupCwd,
      groupWorktree,
      groupCatalogGeneration,
      groupDefaultsStatus,
      model: "",
      catalogLabel: "",
      startTerminal: false,
    };
  }
  const unresolved = (agentId = ""): NewSessionRouteData => ({
    ...requestedLocation,
    agentId,
    requestedAgentId,
    groupStatus,
    groupCwd,
    groupWorktree,
    groupCatalogGeneration,
    groupDefaultsStatus,
    model: "",
    catalogLabel: "",
    startTerminal: false,
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
