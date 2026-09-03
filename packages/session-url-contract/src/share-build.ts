import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { controlUiSessionSlug, normalizeControlUiBasePath } from "./grammar.js";
import { isControlUiReservedRouteSegment, type ControlUiCatalogShareRoute } from "./share.js";

// Keep this subpath out of index.ts: the eager routing barrel would pull share
// construction back into the startup bundle instead of loading it with catalog views.
const LOWERCASE_HEX_RE = /^[0-9a-f]+$/u;
const CATALOG_SHARE_ROUTE_SEGMENT_RE = /^[a-z][a-z0-9-]*$/u;

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

export function buildControlUiCatalogSharePath(params: {
  shareRoute: ControlUiCatalogShareRoute;
  threadId: string;
  displayName?: string;
  basePath?: string;
  prefixLength?: number;
}): string | null {
  const threadId = normalizeNullableString(params.threadId);
  const shareRoute = params.shareRoute;
  if (
    !threadId ||
    !CATALOG_SHARE_ROUTE_SEGMENT_RE.test(shareRoute.routeSegment) ||
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
  const slug = controlUiSessionSlug(params.displayName);
  return `${normalizeControlUiBasePath(params.basePath)}/${shareRoute.routeSegment}/${slug ? `${slug}-` : ""}${threadId.slice(0, length)}`;
}
