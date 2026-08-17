export type NewSessionRouteData = {
  /** The agent the loader resolved; empty until the Gateway can name one. */
  agentId: string;
  /** The agent the URL asked for, which only a navigation can change. */
  requestedAgentId: string;
  catalogId: string;
  group?: string;
  groupStatus?: "resolved" | "missing" | "unavailable";
  groupCwd?: string;
  groupWorktree?: boolean;
  groupCatalogGeneration?: number;
  groupDefaultsStatus?: import("../../lib/sessions/session-capability.ts").SessionGroupDefaultsStatus;
  model: string;
  catalogLabel: string;
  startTerminal: boolean;
};

export type NewSessionTarget =
  | { catalogId: string; group?: never }
  | { group: string; catalogId?: never };

export function newSessionSearch(agentId: string, target?: NewSessionTarget): string {
  const params = new URLSearchParams();
  if (agentId) {
    params.set("agent", agentId);
  }
  if (target?.catalogId) {
    params.set("catalog", target.catalogId);
  }
  if (target?.group) {
    params.set("group", target.group);
  }
  return params.size > 0 ? `?${params.toString()}` : "";
}

export function newSessionLocationFromSearch(
  search: string,
): Pick<NewSessionRouteData, "agentId" | "catalogId" | "group"> {
  const params = new URLSearchParams(search);
  return {
    agentId: params.get("agent")?.trim() ?? "",
    catalogId: params.get("catalog")?.trim() ?? "",
    group: params.get("group")?.trim() ?? "",
  };
}
