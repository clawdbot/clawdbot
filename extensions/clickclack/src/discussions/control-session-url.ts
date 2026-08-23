import { buildControlUiSessionPath } from "openclaw/plugin-sdk/session-discussion";

export function controlSessionUrl(
  baseUrl: string | undefined,
  sessionKey: string,
  fallbackAgentId: string,
  mainKey: string | undefined,
  displayName?: string,
): string | undefined {
  if (!baseUrl) {
    return undefined;
  }
  const url = new URL(baseUrl);
  const path = buildControlUiSessionPath({
    namespace: "chat",
    sessionKey,
    fallbackAgentId,
    basePath: url.pathname,
    displayName,
    mainKey,
  });
  if (!path) {
    return undefined;
  }
  url.pathname = path;
  url.hash = "";
  return url.toString();
}
