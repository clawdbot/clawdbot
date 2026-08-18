import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { normalizeControlUiBasePath } from "./grammar.js";

const LOWERCASE_HEX_RE = /^[0-9a-f]+$/u;
const CATALOG_SHARE_ROUTE_SEGMENT_RE = /^[a-z][a-z0-9-]*$/u;

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
  if (
    !routeSegment ||
    !isControlUiCatalogShareRouteSegment(routeSegment) ||
    idSegments.length === 0
  ) {
    return null;
  }
  const shortId = idSegments.join("/");
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
