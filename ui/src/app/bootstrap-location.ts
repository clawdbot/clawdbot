import type { RouteLocation } from "@openclaw/uirouter";
import { pathForSession, routeIdFromPath } from "../app-routes.ts";
import { resolveAgentIdFromSessionKey } from "../lib/sessions/session-key.ts";
import { isDefaultChatLanding } from "../pages/model-setup/first-run.ts";

export function normalizeInitialApplicationLocation(
  location: RouteLocation,
  basePath: string,
  sessionKey: string,
) {
  if (!isDefaultChatLanding(location, basePath, routeIdFromPath) || !sessionKey.trim()) {
    return location;
  }
  const pathname = pathForSession(
    "chat",
    resolveAgentIdFromSessionKey(sessionKey),
    sessionKey,
    basePath,
  );
  return pathname ? { ...location, pathname } : location;
}
