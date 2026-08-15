import {
  parseControlUiSessionPath,
  type ControlUiSessionPathTarget,
} from "@openclaw/session-url-contract/parse";

export type SessionPathTarget = ControlUiSessionPathTarget;

export function sessionRefFromPath(
  pathname: string,
  basePath = "",
  mainKey?: string,
): SessionPathTarget | null {
  return parseControlUiSessionPath(pathname, basePath, mainKey);
}
