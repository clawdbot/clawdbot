import {
  parseControlUiSessionPath,
  type ControlUiSessionPathTarget,
} from "@openclaw/session-url-contract/parse";

export type SessionPathTarget = ControlUiSessionPathTarget;

export const SIDEBAR_SESSION_NAV_COLLAPSE_QUERY = {
  name: "nav",
  value: "collapsed",
} as const;

export function sessionRefFromPath(
  pathname: string,
  basePath = "",
  mainKey?: string,
): SessionPathTarget | null {
  return parseControlUiSessionPath(pathname, basePath, mainKey);
}
