import {
  parseControlUiSessionPath,
  type ControlUiSessionPathTarget,
} from "@openclaw/session-url-contract/parse";

export type SessionPathTarget = ControlUiSessionPathTarget;

export const SIDEBAR_SESSION_NAV_COLLAPSE_QUERY = {
  name: "nav",
  value: "collapsed",
} as const;

// Native new-tab navigation consumes the href verbatim; SPA clicks use their clean route instead.
export function withSidebarNavCollapseIntent(href: string): string {
  const fragmentIndex = href.indexOf("#");
  const route = fragmentIndex === -1 ? href : href.slice(0, fragmentIndex);
  const fragment = fragmentIndex === -1 ? "" : href.slice(fragmentIndex);
  const queryIndex = route.indexOf("?");
  if (
    queryIndex !== -1 &&
    new URLSearchParams(route.slice(queryIndex + 1)).has(SIDEBAR_SESSION_NAV_COLLAPSE_QUERY.name)
  ) {
    return href;
  }
  const separator = queryIndex === -1 ? "?" : "&";
  return `${route}${separator}${SIDEBAR_SESSION_NAV_COLLAPSE_QUERY.name}=${SIDEBAR_SESSION_NAV_COLLAPSE_QUERY.value}${fragment}`;
}

export function sessionRefFromPath(
  pathname: string,
  basePath = "",
  mainKey?: string,
): SessionPathTarget | null {
  return parseControlUiSessionPath(pathname, basePath, mainKey);
}
