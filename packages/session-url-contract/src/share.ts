import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { normalizeControlUiBasePath } from "./grammar.js";

const LOWERCASE_HEX_RE = /^[0-9a-f]+$/u;
const CATALOG_SHARE_ROUTE_SEGMENT_RE = /^[a-z][a-z0-9-]*$/u;
const CATALOG_SHARE_PATH_CANDIDATE_RE = /^[a-z0-9]{12,}$/iu;

// This stable contract is shared by URL producers and consumers. The Control UI
// route-table test keeps it aligned with every built-in path and alias.
export const CONTROL_UI_RESERVED_ROUTE_SEGMENTS = Object.freeze([
  "activity",
  "agents",
  "ai-agents",
  "appearance",
  "apps",
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
] as const);

const CONTROL_UI_RESERVED_ROUTE_SEGMENT_SET = new Set<string>(CONTROL_UI_RESERVED_ROUTE_SEGMENTS);

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

export function isControlUiCatalogShareId(
  shareRoute: ControlUiCatalogShareRoute,
  value: string,
): boolean {
  return (
    value.length >= shareRoute.minPrefixLength &&
    value.length <= shareRoute.fullLength &&
    LOWERCASE_HEX_RE.test(value)
  );
}

export function isControlUiCatalogShareRouteSegment(value: string): boolean {
  return CATALOG_SHARE_ROUTE_SEGMENT_RE.test(value);
}

export function isControlUiReservedRouteSegment(value: string): boolean {
  return CONTROL_UI_RESERVED_ROUTE_SEGMENT_SET.has(value.toLowerCase());
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
  const [routeSegment, ...idSegments] = params.pathname.slice(prefix.length).split("/");
  const shortId = idSegments[0];
  if (
    !routeSegment ||
    !isControlUiCatalogShareRouteSegment(routeSegment) ||
    isControlUiReservedRouteSegment(routeSegment) ||
    idSegments.length !== 1 ||
    !shortId ||
    !CATALOG_SHARE_PATH_CANDIDATE_RE.test(shortId)
  ) {
    return null;
  }
  return {
    routeSegment,
    shortId,
  };
}

export function buildControlUiCatalogSharePath(params: {
  shareRoute: ControlUiCatalogShareRoute;
  threadId: string;
  basePath?: string;
  prefixLength?: number;
}): string | null {
  const threadId = normalizeNullableString(params.threadId);
  const shareRoute = params.shareRoute;
  if (
    !threadId ||
    !isControlUiCatalogShareRouteSegment(shareRoute.routeSegment) ||
    isControlUiReservedRouteSegment(shareRoute.routeSegment) ||
    threadId.length !== shareRoute.fullLength ||
    !LOWERCASE_HEX_RE.test(threadId)
  ) {
    return null;
  }
  const length = Math.min(
    shareRoute.fullLength,
    Math.max(
      shareRoute.minPrefixLength,
      Math.floor(params.prefixLength ?? shareRoute.minPrefixLength),
    ),
  );
  return `${normalizeControlUiBasePath(params.basePath)}/${shareRoute.routeSegment}/${threadId.slice(0, length)}`;
}
