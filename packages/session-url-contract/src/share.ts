import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { normalizeControlUiBasePath } from "./grammar.js";

const LOWERCASE_HEX_RE = /^[0-9a-f]+$/u;
const CATALOG_SHARE_ROUTE_SEGMENT_RE = /^[a-z][a-z0-9-]*$/u;
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
