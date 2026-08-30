import { normalizeControlUiBasePath } from "./grammar.js";

const CATALOG_SHARE_PATH_RE = /^([a-z][a-z0-9-]*)\/([a-zA-Z0-9]{12,})$/u;

// This stable contract is shared by URL producers and consumers. The Control UI
// route-table test keeps it aligned with every built-in path and alias.
export const CONTROL_UI_RESERVED_ROUTE_SEGMENTS: readonly string[] = Object.freeze([
  "activity",
  "agents",
  "ai-agents",
  "appearance",
  "approve",
  "apps",
  "ask",
  "automation",
  "automations",
  "channels",
  "chat",
  "communications",
  "config",
  "cron",
  "custodian",
  "dashboard",
  "dashboards",
  "debug",
  "focus",
  "infrastructure",
  "lobsterdex",
  "logs",
  "mcp",
  "memory-import",
  "model-providers",
  "model-setup",
  "new",
  "nodes",
  "plugin",
  "portals",
  "profile",
  "sessions",
  "settings",
  "skills",
  "tasks",
  "usage",
  "workboard",
  "worktrees",
]);

export type ControlUiCatalogShareRoute = {
  kind: "thread-id-prefix";
  routeSegment: string;
  hostId: string;
  identifierAlphabet: "lowercase-hex";
  fullLength: 32;
  minPrefixLength: 12;
  lookup: "catalog-list-search-by-thread-id-prefix";
  ambiguity: "multiple-results-or-next-cursor";
};

export type ControlUiCatalogSharePathMatch = {
  routeSegment: string;
  shortId: string;
};

export function isControlUiReservedRouteSegment(value: string): boolean {
  return CONTROL_UI_RESERVED_ROUTE_SEGMENTS.includes(value.toLowerCase());
}

export function matchControlUiCatalogSharePath(params: {
  pathname: string;
  basePath?: string;
}): ControlUiCatalogSharePathMatch | null {
  const basePath = normalizeControlUiBasePath(params.basePath);
  const prefix = `${basePath}/`;
  if (!params.pathname.startsWith(prefix)) {
    return null;
  }
  // SAFETY: The anchored pattern requires exactly two non-empty captures.
  const match = CATALOG_SHARE_PATH_RE.exec(params.pathname.slice(prefix.length)) as
    | [string, string, string]
    | null;
  if (!match || isControlUiReservedRouteSegment(match[1])) {
    return null;
  }
  return {
    routeSegment: match[1],
    shortId: match[2],
  };
}
