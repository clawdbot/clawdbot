import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { normalizeControlUiBasePath } from "./grammar.js";

export const CONTROL_UI_CATALOG_SHARE_SHORT_ID_LENGTH = 12;
export const CONTROL_UI_CATALOG_SHARE_FULL_ID_LENGTH = 32;

const CATALOG_SHARE_ID_RE = /^[0-9a-f]{12,32}$/u;
const CATALOG_SHARE_THREAD_ID_RE = /^[0-9a-f]{32}$/iu;
const CATALOG_SHARE_ROUTE_SEGMENT_RE = /^[a-z][a-z0-9-]*$/u;

export type ControlUiCatalogSharePathMatch = {
  routeSegment: string;
  shortId: string;
  valid: boolean;
};

export function isControlUiCatalogShareId(value: string): boolean {
  return CATALOG_SHARE_ID_RE.test(value);
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
    valid: idSegments.length === 1 && isControlUiCatalogShareId(shortId),
  };
}

export function buildControlUiCatalogSharePath(params: {
  routeSegment: string;
  threadId: string;
  basePath?: string;
  shortIdLength?: number;
}): string | null {
  const threadId = normalizeNullableString(params.threadId);
  if (
    !threadId ||
    !isControlUiCatalogShareRouteSegment(params.routeSegment) ||
    !CATALOG_SHARE_THREAD_ID_RE.test(threadId)
  ) {
    return null;
  }
  const length = Math.min(
    CONTROL_UI_CATALOG_SHARE_FULL_ID_LENGTH,
    Math.max(
      CONTROL_UI_CATALOG_SHARE_SHORT_ID_LENGTH,
      Math.floor(params.shortIdLength ?? CONTROL_UI_CATALOG_SHARE_SHORT_ID_LENGTH),
    ),
  );
  return `${normalizeControlUiBasePath(params.basePath)}/${params.routeSegment}/${threadId.toLowerCase().slice(0, length)}`;
}
