export type NewSessionRouteData = {
  /** The agent the loader resolved; empty until the Gateway can name one. */
  agentId: string;
  /** The agent the URL asked for, which only a navigation can change. */
  requestedAgentId: string;
  catalogId: string;
  model: string;
  catalogLabel: string;
};

export type NewSessionTarget = { catalogId: string };

export function newSessionSearch(agentId: string, target?: NewSessionTarget): string {
  const params = new URLSearchParams();
  if (agentId) {
    params.set("agent", agentId);
  }
  if (target) {
    params.set("catalog", target.catalogId);
  }
  return params.size > 0 ? `?${params.toString()}` : "";
}

export function newSessionLocationFromSearch(
  search: string,
): Pick<NewSessionRouteData, "agentId" | "catalogId"> {
  const params = new URLSearchParams(search);
  return {
    agentId: params.get("agent")?.trim() ?? "",
    catalogId: params.get("catalog")?.trim() ?? "",
  };
}
